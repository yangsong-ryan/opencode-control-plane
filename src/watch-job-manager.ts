import type { ControlPlaneConfig } from "./config.ts"
import type { EventHub } from "./event-hub.ts"
import type { OpenCodeAdapter } from "./opencode-adapter.ts"
import {
  mainAgentSystem,
  workerAgentSystem,
} from "./agent-prompts.ts"
import { InMemoryStore, type JobWatchRecord } from "./store.ts"

const MAX_TIMER_DELAY_MS = 2_147_483_647

export class WatchJobManager {
  private readonly store: InMemoryStore
  private readonly adapter: OpenCodeAdapter
  private readonly events: EventHub
  private readonly config: ControlPlaneConfig
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly delivering = new Set<string>()
  private stopped = false

  constructor(
    store: InMemoryStore,
    adapter: OpenCodeAdapter,
    events: EventHub,
    config: ControlPlaneConfig,
  ) {
    this.store = store
    this.adapter = adapter
    this.events = events
    this.config = config
  }

  schedule(input: {
    callerSessionId: string
    title: string
    wakeMessage: string
    delaySeconds: number
    idempotencyKey?: string
  }): { created: boolean; watch: JobWatchRecord } {
    const agent = this.store.getAgentBySession(input.callerSessionId)
    if (agent === undefined) throw new Error("CALLER_AGENT_NOT_FOUND")
    if (agent.role === "APPROVER") throw new Error("CALLER_IS_NOT_JOB_AGENT")

    const result = this.store.createJobWatch({
      agent,
      title: input.title,
      wakeMessage: input.wakeMessage,
      wakeAt: new Date(Date.now() + input.delaySeconds * 1_000).toISOString(),
      idempotencyKey: input.idempotencyKey,
    })
    if (result.created) {
      this.store.appendAudit({
        type: "job_watch.scheduled",
        taskGroupId: agent.taskGroupId,
        agentId: agent.id,
        data: { watchId: result.watch.id, title: result.watch.title, wakeAt: result.watch.wakeAt },
      })
      this.events.publish("job_watch.scheduled", result.watch)
    }
    if (result.watch.status === "SCHEDULED") this.arm(result.watch)
    return result
  }

  recover(): number {
    const watches = this.store.listJobWatches({ status: "SCHEDULED" })
    for (const watch of watches) this.arm(watch)
    return watches.length
  }

  list(taskGroupId?: string): JobWatchRecord[] {
    return this.store.listJobWatches({ taskGroupId })
  }

  cancel(id: string): JobWatchRecord {
    const current = this.store.getJobWatch(id)
    if (current === undefined) throw new Error("JOB_WATCH_NOT_FOUND")
    const timer = this.timers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(id)
    const watch = this.store.cancelJobWatch(id) ?? current
    if (current.status === "SCHEDULED" && watch.status === "CANCELLED") {
      this.store.appendAudit({
        type: "job_watch.cancelled",
        taskGroupId: watch.taskGroupId,
        agentId: watch.agentId,
        data: { watchId: watch.id, title: watch.title },
      })
      this.events.publish("job_watch.cancelled", watch)
    }
    return watch
  }

  cancelTaskGroup(taskGroupId: string): number {
    const scheduled = this.store.listJobWatches({ taskGroupId, status: "SCHEDULED" })
    for (const watch of scheduled) this.cancel(watch.id)
    return scheduled.length
  }

  async deliverDue(now = Date.now()): Promise<number> {
    const due = this.store
      .listJobWatches({ status: "SCHEDULED" })
      .filter((watch) => Date.parse(watch.wakeAt) <= now)
    await Promise.all(due.map((watch) => this.deliver(watch.id)))
    return due.length
  }

  stop(): void {
    this.stopped = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private arm(watch: JobWatchRecord): void {
    if (this.stopped || watch.status !== "SCHEDULED") return
    const existing = this.timers.get(watch.id)
    if (existing !== undefined) clearTimeout(existing)
    const remaining = Math.max(0, Date.parse(watch.wakeAt) - Date.now())
    const delay = Math.min(remaining, MAX_TIMER_DELAY_MS)
    const timer = setTimeout(() => {
      this.timers.delete(watch.id)
      if (remaining > MAX_TIMER_DELAY_MS) {
        const current = this.store.getJobWatch(watch.id)
        if (current !== undefined) this.arm(current)
        return
      }
      void this.deliver(watch.id)
    }, delay)
    timer.unref()
    this.timers.set(watch.id, timer)
  }

  private async deliver(id: string): Promise<void> {
    if (this.stopped || this.delivering.has(id)) return
    const watch = this.store.getJobWatch(id)
    if (watch === undefined || watch.status !== "SCHEDULED") return
    this.delivering.add(id)
    try {
      const agent = this.store.getAgent(watch.agentId)
      if (agent === undefined || agent.opencodeSessionId !== watch.opencodeSessionId) {
        throw new Error("The original Agent Session is no longer available")
      }
      const main = agent.role === "MAIN"
      await this.adapter.sendAsync(watch.opencodeSessionId, {
        agent: agent.opencodeAgentName,
        model: this.config.opencodeModel,
        system: main ? mainAgentSystem : workerAgentSystem,
        text: [
          `定时检查“${watch.title}”现在到期。`,
          watch.wakeMessage,
          "请先查询外部任务的真实状态或结果，再决定下一步。若仍未完成，可再次调用 watch_job 安排下一次检查。",
        ].join("\n\n"),
      })
      this.store.setAgentStatus(agent.id, "RUNNING")
      const delivered = this.store.deliverJobWatch(id)
      if (delivered?.status === "DELIVERED") {
        this.store.appendAudit({
          type: "job_watch.delivered",
          taskGroupId: delivered.taskGroupId,
          agentId: delivered.agentId,
          data: { watchId: delivered.id, title: delivered.title, wakeAt: delivered.wakeAt },
        })
        this.events.publish("job_watch.delivered", delivered)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failed = this.store.failJobWatch(id, message)
      if (failed?.status === "FAILED") {
        this.store.appendAudit({
          type: "job_watch.failed",
          taskGroupId: failed.taskGroupId,
          agentId: failed.agentId,
          data: { watchId: failed.id, title: failed.title, error: message },
        })
        this.events.publish("job_watch.failed", failed)
      }
    } finally {
      this.delivering.delete(id)
      this.timers.delete(id)
    }
  }
}
