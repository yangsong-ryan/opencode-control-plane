import type { ControlPlaneConfig } from "./config.ts"
import type { EventHub } from "./event-hub.ts"
import type { OpenCodeAdapter } from "./opencode-adapter.ts"
import { workerAgentSystem } from "./agent-prompts.ts"
import { InMemoryStore, type AgentInstance, type WorkerTask, type WorkerTaskInput } from "./store.ts"

export interface SpawnWorkersInput {
  taskGroupId: string
  callerSessionId: string
  requestId: string
  tasks: WorkerTaskInput[]
}

export interface SpawnWorkersResult {
  requestId: string
  idempotent: boolean
  tasks: WorkerTask[]
  agents: AgentInstance[]
}

async function runWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      await task(items[index])
    }
  })
  await Promise.all(workers)
}

export class Orchestrator {
  private readonly inflight = new Map<string, Promise<SpawnWorkersResult>>()
  private readonly store: InMemoryStore
  private readonly adapter: OpenCodeAdapter
  private readonly events: EventHub
  private readonly config: ControlPlaneConfig

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

  async spawnWorkers(input: SpawnWorkersInput): Promise<SpawnWorkersResult> {
    const group = this.store.getTaskGroup(input.taskGroupId)
    if (group === undefined) throw new Error("TASK_GROUP_NOT_FOUND")
    const mainAgent = group.agents.find((agent) => agent.id === group.taskGroup.rootAgentId)
    if (mainAgent === undefined || mainAgent.role !== "MAIN") throw new Error("MAIN_AGENT_NOT_FOUND")
    if (mainAgent.opencodeSessionId !== input.callerSessionId) throw new Error("CALLER_IS_NOT_MAIN_AGENT")

    const availableAgentNames = new Set(
      (await this.adapter.listAgents()).filter((agent) => agent.hidden !== true).map((agent) => agent.name),
    )
    if (input.tasks.some((task) => !availableAgentNames.has(task.agentName))) {
      throw new Error("AGENT_TYPE_NOT_FOUND")
    }

    const key = `${input.taskGroupId}:${input.requestId}`
    const active = this.inflight.get(key)
    if (active !== undefined) {
      const result = await active
      return { ...result, idempotent: true }
    }

    const reserved = this.store.reserveWorkerTasks({
      taskGroupId: input.taskGroupId,
      requestId: input.requestId,
      tasks: input.tasks,
    })
    if (!reserved.created) return this.result(input.taskGroupId, input.requestId, true)

    const operation = this.startReservedTasks(reserved.tasks, mainAgent).then(() =>
      this.result(input.taskGroupId, input.requestId, false),
    )
    this.inflight.set(key, operation)
    try {
      return await operation
    } finally {
      this.inflight.delete(key)
    }
  }

  private async startReservedTasks(tasks: WorkerTask[], mainAgent: AgentInstance): Promise<void> {
    await runWithConcurrency(tasks, this.config.maxConcurrentWorkers, async (task) => {
      this.store.setWorkerTaskStatus(task.id, "STARTING")
      this.events.publish("worker.starting", { taskId: task.id, title: task.title })
      let worker: AgentInstance | undefined
      try {
        const session = await this.adapter.createSession({
          title: `${mainAgent.name} / ${task.title}`,
          parentSessionId: mainAgent.opencodeSessionId,
          model: this.config.opencodeModel,
        })
        worker = this.store.attachWorker({
          taskId: task.id,
          parentAgentId: mainAgent.id,
          sessionId: session.id,
        }).agent
        await this.adapter.sendAsync(session.id, {
          agent: task.agentName,
          text: task.prompt,
          model: this.config.opencodeModel,
          system: workerAgentSystem,
        })
        this.store.setAgentStatus(worker.id, "RUNNING")
        this.store.setWorkerTaskStatus(task.id, "RUNNING")
        this.events.publish("worker.started", { taskId: task.id, agent: this.store.getAgent(worker.id) })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.store.setWorkerTaskStatus(task.id, "FAILED", message)
        if (worker !== undefined) this.store.setAgentStatus(worker.id, "FAILED", message)
        this.events.publish("worker.failed", { taskId: task.id, error: message })
      }
    })
  }

  private result(taskGroupId: string, requestId: string, idempotent: boolean): SpawnWorkersResult {
    const tasks = this.store.getWorkerTasksByRequest(taskGroupId, requestId)
    const agents = tasks
      .map((task) => (task.workerAgentId === undefined ? undefined : this.store.getAgent(task.workerAgentId)))
      .filter((agent) => agent !== undefined)
    return { requestId, idempotent, tasks, agents }
  }
}
