import type { ControlPlaneConfig } from "./config.ts"
import type { EventHub } from "./event-hub.ts"
import type { OpenCodeAdapter } from "./opencode-adapter.ts"
import { mainAgentSystem, workerAgentSystem } from "./agent-prompts.ts"
import { InMemoryStore, type AgentInstance, type AgentQuestion } from "./store.ts"

export class AgentCommunicationManager {
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

  async askMain(input: { callerSessionId: string; question: string; context?: string }): Promise<AgentQuestion> {
    const worker = this.requireRole(input.callerSessionId, "WORKER")
    const group = this.store.getTaskGroup(worker.taskGroupId)
    const main = group?.agents.find((agent) => agent.id === group.taskGroup.rootAgentId)
    if (main?.role !== "MAIN") throw new Error("MAIN_AGENT_NOT_FOUND")

    const question = this.store.createAgentQuestion({
      worker,
      main,
      question: input.question,
      context: input.context,
    })
    this.store.appendAudit({
      type: "agent_question.created",
      taskGroupId: worker.taskGroupId,
      agentId: worker.id,
      data: { questionId: question.id, mainAgentId: main.id, question: input.question },
    })
    await this.adapter.sendAsync(main.opencodeSessionId, {
      agent: main.opencodeAgentName,
      model: this.config.opencodeModel,
      system: mainAgentSystem,
      text: [
        `Worker “${worker.name}” needs your decision or guidance.`,
        `Question ID: ${question.id}`,
        `Question: ${question.question}`,
        question.context === undefined ? undefined : `Context: ${question.context}`,
        "Call answer_worker with this Question ID and your answer.",
      ].filter((line) => line !== undefined).join("\n"),
    })
    this.events.publish("agent_question.created", question)
    return question
  }

  async answerWorker(input: {
    callerSessionId: string
    questionId: string
    answer: string
  }): Promise<AgentQuestion> {
    const main = this.requireRole(input.callerSessionId, "MAIN")
    const question = this.store.getAgentQuestion(input.questionId)
    if (question === undefined) throw new Error("AGENT_QUESTION_NOT_FOUND")
    if (question.mainAgentId !== main.id || question.taskGroupId !== main.taskGroupId) {
      throw new Error("QUESTION_DOES_NOT_BELONG_TO_MAIN_AGENT")
    }
    const worker = this.store.getAgent(question.workerAgentId)
    if (worker?.role !== "WORKER") throw new Error("WORKER_AGENT_NOT_FOUND")
    const answered = this.store.answerAgentQuestion(question.id, input.answer)
    if (answered === undefined) throw new Error("AGENT_QUESTION_NOT_FOUND")

    if (question.status === "OPEN") {
      await this.adapter.sendAsync(worker.opencodeSessionId, {
        agent: worker.opencodeAgentName,
        model: this.config.opencodeModel,
        system: workerAgentSystem,
        text: [
          "Your main Agent answered your earlier question.",
          `Question: ${question.question}`,
          `Answer: ${input.answer}`,
          "Continue the assigned investigation using this guidance.",
        ].join("\n"),
      })
      this.store.appendAudit({
        type: "agent_question.answered",
        taskGroupId: main.taskGroupId,
        agentId: worker.id,
        data: { questionId: question.id, mainAgentId: main.id, answer: input.answer },
      })
      this.events.publish("agent_question.answered", answered)
    }
    return answered
  }

  listWorkers(callerSessionId: string): Array<{
    agent: AgentInstance
    task: unknown
    openQuestions: AgentQuestion[]
  }> {
    const main = this.requireRole(callerSessionId, "MAIN")
    const group = this.store.getTaskGroup(main.taskGroupId)
    if (group === undefined) throw new Error("TASK_GROUP_NOT_FOUND")
    return group.agents
      .filter((agent) => agent.role === "WORKER")
      .map((agent) => ({
        agent,
        task: group.workerTasks.find((task) => task.workerAgentId === agent.id),
        openQuestions: group.agentQuestions.filter(
          (question) => question.workerAgentId === agent.id && question.status === "OPEN",
        ),
      }))
  }

  async listAgentTypes(callerSessionId: string): Promise<Array<{
    name: string
    description?: string
    mode?: "primary" | "subagent" | "all"
    native: boolean
  }>> {
    this.requireRole(callerSessionId, "MAIN")
    const agents = await this.adapter.listAgents()
    return agents
      .filter((agent) => agent.hidden !== true)
      .map((agent) => ({
        name: agent.name,
        description: agent.description,
        mode: agent.mode,
        native: agent.native === true,
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  listActiveAgents(callerSessionId: string): ReturnType<AgentCommunicationManager["listWorkers"]> {
    return this.listWorkers(callerSessionId).filter(({ agent }) =>
      agent.lifecycleStatus !== "FAILED",
    )
  }

  async messageWorker(input: {
    callerSessionId: string
    workerAgentId: string
    message: string
  }): Promise<{ accepted: true; worker: AgentInstance }> {
    const main = this.requireRole(input.callerSessionId, "MAIN")
    const worker = this.store.getAgent(input.workerAgentId)
    if (worker?.role !== "WORKER" || worker.taskGroupId !== main.taskGroupId) {
      throw new Error("WORKER_DOES_NOT_BELONG_TO_MAIN_AGENT")
    }
    await this.adapter.sendAsync(worker.opencodeSessionId, {
      agent: worker.opencodeAgentName,
      model: this.config.opencodeModel,
      system: workerAgentSystem,
      text: `Supervisory message from your main Agent:\n${input.message}\nContinue your work accordingly.`,
    })
    this.store.appendAudit({
      type: "agent.supervisor_message",
      taskGroupId: main.taskGroupId,
      agentId: worker.id,
      data: { mainAgentId: main.id, message: input.message },
    })
    this.events.publish("agent.supervisor_message", { mainAgentId: main.id, workerAgentId: worker.id })
    return { accepted: true, worker }
  }

  private requireRole(sessionId: string, role: "MAIN" | "WORKER"): AgentInstance {
    const agent = this.store.getAgentBySession(sessionId)
    if (agent?.role !== role) throw new Error(`CALLER_IS_NOT_${role}_AGENT`)
    return agent
  }
}
