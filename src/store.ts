import { randomUUID } from "node:crypto"

export type AgentRole = "MAIN" | "WORKER" | "APPROVER"
export type AgentLifecycleStatus =
  | "CREATING"
  | "READY"
  | "RUNNING"
  | "WAITING_APPROVAL"
  | "IDLE"
  | "FAILED"
  | "CANCELLED"
export type WorkerTaskStatus = "PENDING" | "STARTING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED"
export type PermissionStatus = "PENDING" | "APPROVED" | "REJECTED" | "FAILED"
export type PermissionDecision = "once" | "always" | "reject"
export type PermissionDecisionSource =
  | "STATIC_POLICY"
  | "APPROVAL_AGENT"
  // Kept so databases created by milestone C can still be read.
  | "MAIN_AGENT"
  | "HUMAN"
  | "EXTERNAL"
export type PermissionRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"

export interface AgentInstance {
  id: string
  taskGroupId: string
  parentAgentId?: string
  role: AgentRole
  name: string
  opencodeSessionId: string
  opencodeAgentName: string
  lifecycleStatus: AgentLifecycleStatus
  lastError?: string
  createdAt: string
  updatedAt: string
}

export interface TaskGroup {
  id: string
  title: string
  rootAgentId: string
  status: "RUNNING" | "FAILED" | "CANCELLED"
  approvalPolicy: string
  createdAt: string
  updatedAt: string
}

export interface WorkerTask {
  id: string
  taskGroupId: string
  requestId: string
  fieldKey: string
  title: string
  prompt: string
  agentName: string
  workerAgentId?: string
  status: WorkerTaskStatus
  error?: string
  createdAt: string
  updatedAt: string
}

export interface WorkerTaskInput {
  fieldKey: string
  title: string
  prompt: string
  agentName: string
}

export interface PermissionRequestRecord {
  id: string
  taskGroupId: string
  agentId: string
  opencodeRequestId: string
  opencodeSessionId: string
  action: string
  resources: string[]
  metadata: Record<string, unknown>
  source?: Record<string, unknown>
  tool?: Record<string, unknown>
  risk: PermissionRisk
  status: PermissionStatus
  reviewRequested: boolean
  approvalSessionId?: string
  approvalPolicySnapshot?: string
  approvalContextSnapshot?: string
  approvalReview?: "approve_once" | "reject" | "escalate"
  approvalReason?: string
  recommendationRequested?: boolean
  decision?: PermissionDecision
  decisionSource?: PermissionDecisionSource
  rationale?: string
  requestedAt: string
  decidedAt?: string
  updatedAt: string
}

export interface AuditRecord {
  id: string
  type: string
  taskGroupId?: string
  agentId?: string
  permissionId?: string
  data: Record<string, unknown>
  createdAt: string
}

export interface AgentQuestion {
  id: string
  taskGroupId: string
  workerAgentId: string
  mainAgentId: string
  question: string
  context?: string
  status: "OPEN" | "ANSWERED"
  answer?: string
  createdAt: string
  answeredAt?: string
  updatedAt: string
}

export type ChangeReviewStatus = "PENDING" | "APPROVED" | "REJECTED"

export interface ChangeReviewInlineSegment {
  text: string
  changed: boolean
}

export interface ChangeReviewRow {
  kind: "context" | "modified" | "added" | "deleted"
  beforeLine?: number
  afterLine?: number
  beforeText?: string
  afterText?: string
  beforeSegments?: ChangeReviewInlineSegment[]
  afterSegments?: ChangeReviewInlineSegment[]
}

export interface ChangeReviewFile {
  path: string
  beforePath: string
  afterPath: string
  diff: string
  additions: number
  deletions: number
  rows: ChangeReviewRow[]
}

export interface ChangeReviewRecord {
  id: string
  taskGroupId: string
  agentId: string
  summary: string
  files: ChangeReviewFile[]
  additions: number
  deletions: number
  status: ChangeReviewStatus
  rationale?: string
  requestedAt: string
  decidedAt?: string
  updatedAt: string
}

export type JobWatchStatus = "SCHEDULED" | "DELIVERED" | "CANCELLED" | "FAILED"

export interface JobWatchRecord {
  id: string
  taskGroupId: string
  agentId: string
  opencodeSessionId: string
  title: string
  wakeMessage: string
  wakeAt: string
  status: JobWatchStatus
  idempotencyKey?: string
  createdAt: string
  updatedAt: string
  deliveredAt?: string
  cancelledAt?: string
  lastError?: string
}

export interface StoreSnapshot {
  schemaVersion: 1
  taskGroups: TaskGroup[]
  agents: AgentInstance[]
  workerTasks: WorkerTask[]
  spawnRequests: Array<{ key: string; taskIds: string[] }>
  permissionRequests: PermissionRequestRecord[]
  auditRecords: AuditRecord[]
  agentQuestions: AgentQuestion[]
  changeReviews?: ChangeReviewRecord[]
  jobWatches?: JobWatchRecord[]
}

export interface StoreRecoveryResult {
  activeAgents: number
  missingAgents: number
  resetAgents: number
}

export class InMemoryStore {
  private readonly taskGroups = new Map<string, TaskGroup>()
  private readonly agents = new Map<string, AgentInstance>()
  private readonly agentBySession = new Map<string, string>()
  private readonly workerTasks = new Map<string, WorkerTask>()
  private readonly spawnRequests = new Map<string, string[]>()
  private readonly permissionRequests = new Map<string, PermissionRequestRecord>()
  private readonly permissionByExternalId = new Map<string, string>()
  private readonly auditRecords: AuditRecord[] = []
  private readonly agentQuestions = new Map<string, AgentQuestion>()
  private readonly changeReviews = new Map<string, ChangeReviewRecord>()
  private readonly jobWatches = new Map<string, JobWatchRecord>()

  protected persist(): void {
    // In-memory storage has nothing to flush. Persistent stores override this hook.
  }

  private touchTaskGroup(id: string, timestamp = new Date().toISOString()): void {
    const current = this.taskGroups.get(id)
    if (current !== undefined) this.taskGroups.set(id, { ...current, updatedAt: timestamp })
  }

  protected snapshot(): StoreSnapshot {
    return {
      schemaVersion: 1,
      taskGroups: [...this.taskGroups.values()],
      agents: [...this.agents.values()],
      workerTasks: [...this.workerTasks.values()],
      spawnRequests: [...this.spawnRequests.entries()].map(([key, taskIds]) => ({ key, taskIds: [...taskIds] })),
      permissionRequests: [...this.permissionRequests.values()],
      auditRecords: [...this.auditRecords],
      agentQuestions: [...this.agentQuestions.values()],
      changeReviews: [...this.changeReviews.values()],
      jobWatches: [...this.jobWatches.values()],
    }
  }

  protected restoreSnapshot(snapshot: StoreSnapshot): void {
    this.taskGroups.clear()
    this.agents.clear()
    this.agentBySession.clear()
    this.workerTasks.clear()
    this.spawnRequests.clear()
    this.permissionRequests.clear()
    this.permissionByExternalId.clear()
    this.auditRecords.splice(0)
    this.agentQuestions.clear()
    this.changeReviews.clear()
    this.jobWatches.clear()

    for (const taskGroup of snapshot.taskGroups) {
      this.taskGroups.set(taskGroup.id, { ...taskGroup, approvalPolicy: taskGroup.approvalPolicy ?? "" })
    }
    for (const agent of snapshot.agents) {
      const compatible = { ...agent, opencodeAgentName: agent.opencodeAgentName ?? "build" }
      this.agents.set(agent.id, compatible)
      this.agentBySession.set(compatible.opencodeSessionId, compatible.id)
    }
    for (const task of snapshot.workerTasks) {
      this.workerTasks.set(task.id, { ...task, agentName: task.agentName ?? "build" })
    }
    for (const request of snapshot.spawnRequests) this.spawnRequests.set(request.key, [...request.taskIds])
    for (const permission of snapshot.permissionRequests) {
      const compatible = {
        ...permission,
        reviewRequested: permission.reviewRequested ?? permission.recommendationRequested ?? false,
      }
      this.permissionRequests.set(permission.id, compatible)
      this.permissionByExternalId.set(
        `${permission.opencodeSessionId}:${permission.opencodeRequestId}`,
        permission.id,
      )
    }
    this.auditRecords.push(...snapshot.auditRecords)
    for (const question of snapshot.agentQuestions ?? []) this.agentQuestions.set(question.id, question)
    for (const review of snapshot.changeReviews ?? []) this.changeReviews.set(review.id, review)
    for (const watch of snapshot.jobWatches ?? []) this.jobWatches.set(watch.id, watch)
  }

  createTaskGroup(input: { title: string; sessionId: string; agentName?: string; approvalPolicy: string }): { taskGroup: TaskGroup; agent: AgentInstance } {
    const timestamp = new Date().toISOString()
    const taskGroupId = randomUUID()
    const agentId = randomUUID()

    const taskGroup: TaskGroup = {
      id: taskGroupId,
      title: input.title,
      rootAgentId: agentId,
      status: "RUNNING",
      approvalPolicy: input.approvalPolicy,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const agent: AgentInstance = {
      id: agentId,
      taskGroupId,
      role: "MAIN",
      name: input.title,
      opencodeSessionId: input.sessionId,
      opencodeAgentName: input.agentName ?? "build",
      lifecycleStatus: "READY",
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    this.taskGroups.set(taskGroup.id, taskGroup)
    this.agents.set(agent.id, agent)
    this.agentBySession.set(agent.opencodeSessionId, agent.id)
    this.persist()
    return { taskGroup, agent }
  }

  setTaskGroupApprovalPolicy(taskGroupId: string, approvalPolicy: string): TaskGroup {
    const current = this.taskGroups.get(taskGroupId)
    if (current === undefined) throw new Error("TASK_GROUP_NOT_FOUND")
    const updated = { ...current, approvalPolicy, updatedAt: new Date().toISOString() }
    this.taskGroups.set(taskGroupId, updated)
    this.persist()
    return updated
  }

  renameTaskGroup(taskGroupId: string, title: string): TaskGroup {
    const current = this.taskGroups.get(taskGroupId)
    if (current === undefined) throw new Error("TASK_GROUP_NOT_FOUND")
    const timestamp = new Date().toISOString()
    const updated = { ...current, title, updatedAt: timestamp }
    this.taskGroups.set(taskGroupId, updated)
    const main = this.agents.get(current.rootAgentId)
    if (main !== undefined) this.agents.set(main.id, { ...main, name: title, updatedAt: timestamp })
    this.persist()
    return updated
  }

  deleteTaskGroup(taskGroupId: string): ReturnType<InMemoryStore["getTaskGroup"]> {
    const group = this.getTaskGroup(taskGroupId)
    if (group === undefined) return undefined
    this.taskGroups.delete(taskGroupId)
    const agentIds = new Set(group.agents.map((agent) => agent.id))
    for (const agent of group.agents) {
      this.agents.delete(agent.id)
      this.agentBySession.delete(agent.opencodeSessionId)
    }
    for (const [id, task] of this.workerTasks) if (task.taskGroupId === taskGroupId) this.workerTasks.delete(id)
    for (const key of this.spawnRequests.keys()) if (key.startsWith(`${taskGroupId}:`)) this.spawnRequests.delete(key)
    for (const [id, permission] of this.permissionRequests) {
      if (permission.taskGroupId !== taskGroupId) continue
      this.permissionRequests.delete(id)
      this.permissionByExternalId.delete(`${permission.opencodeSessionId}:${permission.opencodeRequestId}`)
    }
    for (const [id, question] of this.agentQuestions) if (question.taskGroupId === taskGroupId) this.agentQuestions.delete(id)
    for (const [id, review] of this.changeReviews) if (review.taskGroupId === taskGroupId) this.changeReviews.delete(id)
    for (const [id, watch] of this.jobWatches) if (watch.taskGroupId === taskGroupId) this.jobWatches.delete(id)
    const retainedAudits = this.auditRecords.filter((record) => record.taskGroupId !== taskGroupId && (record.agentId === undefined || !agentIds.has(record.agentId)))
    this.auditRecords.splice(0, this.auditRecords.length, ...retainedAudits)
    this.persist()
    return group
  }

  getTaskGroup(id: string): {
    taskGroup: TaskGroup
    agents: AgentInstance[]
    workerTasks: WorkerTask[]
    agentQuestions: AgentQuestion[]
  } | undefined {
    const taskGroup = this.taskGroups.get(id)
    if (taskGroup === undefined) return undefined
    const agents = [...this.agents.values()].filter((agent) => agent.taskGroupId === id)
    const workerTasks = [...this.workerTasks.values()].filter((task) => task.taskGroupId === id)
    const agentQuestions = [...this.agentQuestions.values()].filter((question) => question.taskGroupId === id)
    return { taskGroup, agents, workerTasks, agentQuestions }
  }

  listTaskGroups(): Array<{
    taskGroup: TaskGroup
    agents: AgentInstance[]
    workerTasks: WorkerTask[]
    agentQuestions: AgentQuestion[]
  }> {
    return [...this.taskGroups.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((taskGroup) => this.getTaskGroup(taskGroup.id))
      .filter((group) => group !== undefined)
  }

  getAgent(id: string): AgentInstance | undefined {
    return this.agents.get(id)
  }

  getAgentBySession(sessionId: string): AgentInstance | undefined {
    const agentId = this.agentBySession.get(sessionId)
    return agentId === undefined ? undefined : this.agents.get(agentId)
  }

  migrateSystemAgentNames(input: { mainAgentName: string; approvalAgentName: string }): number {
    let migrated = 0
    const timestamp = new Date().toISOString()
    for (const [id, agent] of this.agents) {
      const target = agent.role === "MAIN"
        ? input.mainAgentName
        : agent.role === "APPROVER"
          ? input.approvalAgentName
          : undefined
      if (target === undefined || agent.opencodeAgentName !== "build") continue
      this.agents.set(id, { ...agent, opencodeAgentName: target, updatedAt: timestamp })
      this.touchTaskGroup(agent.taskGroupId, timestamp)
      migrated += 1
    }
    if (migrated > 0) this.persist()
    return migrated
  }

  setAgentStatus(
    id: string,
    lifecycleStatus: AgentLifecycleStatus,
    lastError?: string,
  ): AgentInstance | undefined {
    const current = this.agents.get(id)
    if (current === undefined) return undefined
    const updated: AgentInstance = {
      ...current,
      lifecycleStatus,
      lastError: lastError ?? current.lastError,
      updatedAt: new Date().toISOString(),
    }
    this.agents.set(id, updated)
    this.touchTaskGroup(current.taskGroupId, updated.updatedAt)
    this.persist()
    return updated
  }

  reserveWorkerTasks(input: {
    taskGroupId: string
    requestId: string
    tasks: WorkerTaskInput[]
  }): { created: boolean; tasks: WorkerTask[] } {
    const key = `${input.taskGroupId}:${input.requestId}`
    const existingIds = this.spawnRequests.get(key)
    if (existingIds !== undefined) {
      return {
        created: false,
        tasks: existingIds.map((id) => this.workerTasks.get(id)).filter((task) => task !== undefined),
      }
    }

    const timestamp = new Date().toISOString()
    const tasks = input.tasks.map<WorkerTask>((task) => ({
      id: randomUUID(),
      taskGroupId: input.taskGroupId,
      requestId: input.requestId,
      fieldKey: task.fieldKey,
      title: task.title,
      prompt: task.prompt,
      agentName: task.agentName,
      status: "PENDING",
      createdAt: timestamp,
      updatedAt: timestamp,
    }))
    for (const task of tasks) this.workerTasks.set(task.id, task)
    this.spawnRequests.set(key, tasks.map((task) => task.id))
    this.touchTaskGroup(input.taskGroupId, timestamp)
    this.persist()
    return { created: true, tasks }
  }

  getWorkerTasksByRequest(taskGroupId: string, requestId: string): WorkerTask[] {
    const ids = this.spawnRequests.get(`${taskGroupId}:${requestId}`) ?? []
    return ids.map((id) => this.workerTasks.get(id)).filter((task) => task !== undefined)
  }

  setWorkerTaskStatus(id: string, status: WorkerTaskStatus, error?: string): WorkerTask | undefined {
    const current = this.workerTasks.get(id)
    if (current === undefined) return undefined
    const updated: WorkerTask = {
      ...current,
      status,
      error: error ?? current.error,
      updatedAt: new Date().toISOString(),
    }
    this.workerTasks.set(id, updated)
    this.touchTaskGroup(current.taskGroupId, updated.updatedAt)
    this.persist()
    return updated
  }

  attachWorker(input: {
    taskId: string
    parentAgentId: string
    sessionId: string
  }): { task: WorkerTask; agent: AgentInstance } {
    const task = this.workerTasks.get(input.taskId)
    if (task === undefined) throw new Error("WORKER_TASK_NOT_FOUND")
    const timestamp = new Date().toISOString()
    const agent: AgentInstance = {
      id: randomUUID(),
      taskGroupId: task.taskGroupId,
      parentAgentId: input.parentAgentId,
      role: "WORKER",
      name: task.title,
      opencodeSessionId: input.sessionId,
      opencodeAgentName: task.agentName,
      lifecycleStatus: "READY",
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const updatedTask: WorkerTask = { ...task, workerAgentId: agent.id, updatedAt: timestamp }
    this.agents.set(agent.id, agent)
    this.agentBySession.set(agent.opencodeSessionId, agent.id)
    this.workerTasks.set(task.id, updatedTask)
    this.touchTaskGroup(task.taskGroupId, timestamp)
    this.persist()
    return { task: updatedTask, agent }
  }

  attachApprover(input: {
    taskGroupId: string
    parentAgentId: string
    sessionId: string
    name?: string
    agentName?: string
  }): AgentInstance {
    const taskGroup = this.taskGroups.get(input.taskGroupId)
    if (taskGroup === undefined) throw new Error("TASK_GROUP_NOT_FOUND")
    const timestamp = new Date().toISOString()
    const agent: AgentInstance = {
      id: randomUUID(),
      taskGroupId: input.taskGroupId,
      parentAgentId: input.parentAgentId,
      role: "APPROVER",
      name: input.name ?? "权限审批",
      opencodeSessionId: input.sessionId,
      opencodeAgentName: input.agentName ?? "build",
      lifecycleStatus: "READY",
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.agents.set(agent.id, agent)
    this.agentBySession.set(agent.opencodeSessionId, agent.id)
    this.touchTaskGroup(input.taskGroupId, timestamp)
    this.persist()
    return agent
  }

  upsertPermissionRequest(input: {
    agent: AgentInstance
    opencodeRequestId: string
    action: string
    resources: string[]
    metadata: Record<string, unknown>
    source?: Record<string, unknown>
    tool?: Record<string, unknown>
    risk: PermissionRisk
  }): { created: boolean; permission: PermissionRequestRecord } {
    const externalKey = `${input.agent.opencodeSessionId}:${input.opencodeRequestId}`
    const existingId = this.permissionByExternalId.get(externalKey)
    if (existingId !== undefined) {
      const existing = this.permissionRequests.get(existingId)
      if (existing !== undefined) return { created: false, permission: existing }
    }

    const timestamp = new Date().toISOString()
    const permission: PermissionRequestRecord = {
      id: randomUUID(),
      taskGroupId: input.agent.taskGroupId,
      agentId: input.agent.id,
      opencodeRequestId: input.opencodeRequestId,
      opencodeSessionId: input.agent.opencodeSessionId,
      action: input.action,
      resources: [...input.resources],
      metadata: { ...input.metadata },
      source: input.source === undefined ? undefined : { ...input.source },
      tool: input.tool === undefined ? undefined : { ...input.tool },
      risk: input.risk,
      status: "PENDING",
      reviewRequested: false,
      requestedAt: timestamp,
      updatedAt: timestamp,
    }
    this.permissionRequests.set(permission.id, permission)
    this.permissionByExternalId.set(externalKey, permission.id)
    this.touchTaskGroup(input.agent.taskGroupId, timestamp)
    this.persist()
    return { created: true, permission }
  }

  getPermissionRequest(id: string): PermissionRequestRecord | undefined {
    return this.permissionRequests.get(id)
  }

  getPermissionRequestByExternal(sessionId: string, requestId: string): PermissionRequestRecord | undefined {
    const id = this.permissionByExternalId.get(`${sessionId}:${requestId}`)
    return id === undefined ? undefined : this.permissionRequests.get(id)
  }

  listPermissionRequests(filter: { taskGroupId?: string; status?: PermissionStatus } = {}): PermissionRequestRecord[] {
    return [...this.permissionRequests.values()]
      .filter((permission) => filter.taskGroupId === undefined || permission.taskGroupId === filter.taskGroupId)
      .filter((permission) => filter.status === undefined || permission.status === filter.status)
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
  }

  markPermissionReviewRequested(input: {
    id: string
    approvalSessionId: string
    approvalPolicySnapshot: string
    approvalContextSnapshot: string
  }): PermissionRequestRecord | undefined {
    const current = this.permissionRequests.get(input.id)
    if (current === undefined || current.status !== "PENDING") return current
    const updated = {
      ...current,
      reviewRequested: true,
      approvalSessionId: input.approvalSessionId,
      approvalPolicySnapshot: input.approvalPolicySnapshot,
      approvalContextSnapshot: input.approvalContextSnapshot,
      updatedAt: new Date().toISOString(),
    }
    this.permissionRequests.set(input.id, updated)
    this.touchTaskGroup(current.taskGroupId, updated.updatedAt)
    this.persist()
    return updated
  }

  recordPermissionApprovalReview(input: {
    id: string
    review: "approve_once" | "reject" | "escalate"
    reason: string
  }): PermissionRequestRecord | undefined {
    const current = this.permissionRequests.get(input.id)
    if (current === undefined) return undefined
    const updated = {
      ...current,
      approvalReview: input.review,
      approvalReason: input.reason,
      updatedAt: new Date().toISOString(),
    }
    this.permissionRequests.set(input.id, updated)
    this.touchTaskGroup(current.taskGroupId, updated.updatedAt)
    this.persist()
    return updated
  }

  resolvePermissionRequest(input: {
    id: string
    decision: PermissionDecision
    source: PermissionDecisionSource
    rationale?: string
  }): PermissionRequestRecord | undefined {
    const current = this.permissionRequests.get(input.id)
    if (current === undefined || current.status !== "PENDING") return current
    const timestamp = new Date().toISOString()
    const updated: PermissionRequestRecord = {
      ...current,
      status: input.decision === "reject" ? "REJECTED" : "APPROVED",
      decision: input.decision,
      decisionSource: input.source,
      rationale: input.rationale,
      decidedAt: timestamp,
      updatedAt: timestamp,
    }
    this.permissionRequests.set(input.id, updated)
    this.touchTaskGroup(current.taskGroupId, timestamp)
    this.persist()
    return updated
  }

  failPermissionRequest(id: string, rationale: string): PermissionRequestRecord | undefined {
    const current = this.permissionRequests.get(id)
    if (current === undefined || current.status !== "PENDING") return current
    const updated: PermissionRequestRecord = {
      ...current,
      status: "FAILED",
      rationale,
      updatedAt: new Date().toISOString(),
    }
    this.permissionRequests.set(id, updated)
    this.touchTaskGroup(current.taskGroupId, updated.updatedAt)
    this.persist()
    return updated
  }

  hasPendingPermissionsForAgent(agentId: string): boolean {
    return [...this.permissionRequests.values()].some(
      (permission) => permission.agentId === agentId && permission.status === "PENDING",
    )
  }

  appendAudit(input: Omit<AuditRecord, "id" | "createdAt">): AuditRecord {
    const record: AuditRecord = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }
    this.auditRecords.push(record)
    if (input.taskGroupId !== undefined) this.touchTaskGroup(input.taskGroupId, record.createdAt)
    this.persist()
    return record
  }

  listAuditRecords(limit = 100): AuditRecord[] {
    return this.auditRecords.slice(-Math.max(1, limit)).reverse()
  }

  createAgentQuestion(input: {
    worker: AgentInstance
    main: AgentInstance
    question: string
    context?: string
  }): AgentQuestion {
    if (input.worker.role !== "WORKER" || input.main.role !== "MAIN") throw new Error("INVALID_AGENT_QUESTION")
    if (input.worker.taskGroupId !== input.main.taskGroupId) throw new Error("AGENT_GROUP_MISMATCH")
    const timestamp = new Date().toISOString()
    const question: AgentQuestion = {
      id: randomUUID(),
      taskGroupId: input.worker.taskGroupId,
      workerAgentId: input.worker.id,
      mainAgentId: input.main.id,
      question: input.question,
      context: input.context,
      status: "OPEN",
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.agentQuestions.set(question.id, question)
    this.touchTaskGroup(question.taskGroupId, timestamp)
    this.persist()
    return question
  }

  getAgentQuestion(id: string): AgentQuestion | undefined {
    return this.agentQuestions.get(id)
  }

  listAgentQuestions(filter: { taskGroupId?: string; status?: AgentQuestion["status"] } = {}): AgentQuestion[] {
    return [...this.agentQuestions.values()]
      .filter((question) => filter.taskGroupId === undefined || question.taskGroupId === filter.taskGroupId)
      .filter((question) => filter.status === undefined || question.status === filter.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  answerAgentQuestion(id: string, answer: string): AgentQuestion | undefined {
    const current = this.agentQuestions.get(id)
    if (current === undefined || current.status === "ANSWERED") return current
    const timestamp = new Date().toISOString()
    const updated: AgentQuestion = {
      ...current,
      status: "ANSWERED",
      answer,
      answeredAt: timestamp,
      updatedAt: timestamp,
    }
    this.agentQuestions.set(id, updated)
    this.touchTaskGroup(updated.taskGroupId, timestamp)
    this.persist()
    return updated
  }

  createChangeReview(input: {
    agent: AgentInstance
    summary: string
    files: ChangeReviewFile[]
  }): ChangeReviewRecord {
    const timestamp = new Date().toISOString()
    const review: ChangeReviewRecord = {
      id: randomUUID(),
      taskGroupId: input.agent.taskGroupId,
      agentId: input.agent.id,
      summary: input.summary,
      files: input.files.map((file) => ({ ...file })),
      additions: input.files.reduce((sum, file) => sum + file.additions, 0),
      deletions: input.files.reduce((sum, file) => sum + file.deletions, 0),
      status: "PENDING",
      requestedAt: timestamp,
      updatedAt: timestamp,
    }
    this.changeReviews.set(review.id, review)
    this.touchTaskGroup(input.agent.taskGroupId, timestamp)
    this.persist()
    return review
  }

  getChangeReview(id: string): ChangeReviewRecord | undefined {
    return this.changeReviews.get(id)
  }

  listChangeReviews(filter: { taskGroupId?: string; status?: ChangeReviewStatus } = {}): ChangeReviewRecord[] {
    return [...this.changeReviews.values()]
      .filter((review) => filter.taskGroupId === undefined || review.taskGroupId === filter.taskGroupId)
      .filter((review) => filter.status === undefined || review.status === filter.status)
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
  }

  decideChangeReview(input: {
    id: string
    decision: "approve" | "reject"
    rationale?: string
  }): ChangeReviewRecord | undefined {
    const current = this.changeReviews.get(input.id)
    if (current === undefined || current.status !== "PENDING") return current
    const timestamp = new Date().toISOString()
    const status = input.decision === "approve" ? "APPROVED" : "REJECTED"
    const updated: ChangeReviewRecord = {
      ...current,
      status,
      rationale: input.rationale,
      decidedAt: timestamp,
      updatedAt: timestamp,
    }
    this.changeReviews.set(updated.id, updated)
    this.touchTaskGroup(current.taskGroupId, timestamp)
    this.persist()
    return updated
  }

  createJobWatch(input: {
    agent: AgentInstance
    title: string
    wakeMessage: string
    wakeAt: string
    idempotencyKey?: string
  }): { created: boolean; watch: JobWatchRecord } {
    if (input.idempotencyKey !== undefined) {
      const existing = [...this.jobWatches.values()].find(
        (watch) => watch.agentId === input.agent.id && watch.idempotencyKey === input.idempotencyKey,
      )
      if (existing !== undefined) return { created: false, watch: existing }
    }

    const timestamp = new Date().toISOString()
    const watch: JobWatchRecord = {
      id: randomUUID(),
      taskGroupId: input.agent.taskGroupId,
      agentId: input.agent.id,
      opencodeSessionId: input.agent.opencodeSessionId,
      title: input.title,
      wakeMessage: input.wakeMessage,
      wakeAt: input.wakeAt,
      status: "SCHEDULED",
      idempotencyKey: input.idempotencyKey,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.jobWatches.set(watch.id, watch)
    this.touchTaskGroup(watch.taskGroupId, timestamp)
    this.persist()
    return { created: true, watch }
  }

  getJobWatch(id: string): JobWatchRecord | undefined {
    return this.jobWatches.get(id)
  }

  listJobWatches(filter: {
    taskGroupId?: string
    agentId?: string
    status?: JobWatchStatus
  } = {}): JobWatchRecord[] {
    return [...this.jobWatches.values()]
      .filter((watch) => filter.taskGroupId === undefined || watch.taskGroupId === filter.taskGroupId)
      .filter((watch) => filter.agentId === undefined || watch.agentId === filter.agentId)
      .filter((watch) => filter.status === undefined || watch.status === filter.status)
      .sort((left, right) => left.wakeAt.localeCompare(right.wakeAt))
  }

  deliverJobWatch(id: string): JobWatchRecord | undefined {
    const current = this.jobWatches.get(id)
    if (current === undefined || current.status !== "SCHEDULED") return current
    const timestamp = new Date().toISOString()
    const updated: JobWatchRecord = {
      ...current,
      status: "DELIVERED",
      deliveredAt: timestamp,
      updatedAt: timestamp,
      lastError: undefined,
    }
    this.jobWatches.set(id, updated)
    this.touchTaskGroup(current.taskGroupId, timestamp)
    this.persist()
    return updated
  }

  failJobWatch(id: string, error: string): JobWatchRecord | undefined {
    const current = this.jobWatches.get(id)
    if (current === undefined || current.status !== "SCHEDULED") return current
    const timestamp = new Date().toISOString()
    const updated: JobWatchRecord = {
      ...current,
      status: "FAILED",
      lastError: error,
      updatedAt: timestamp,
    }
    this.jobWatches.set(id, updated)
    this.touchTaskGroup(current.taskGroupId, timestamp)
    this.persist()
    return updated
  }

  cancelJobWatch(id: string): JobWatchRecord | undefined {
    const current = this.jobWatches.get(id)
    if (current === undefined || current.status !== "SCHEDULED") return current
    const timestamp = new Date().toISOString()
    const updated: JobWatchRecord = {
      ...current,
      status: "CANCELLED",
      cancelledAt: timestamp,
      updatedAt: timestamp,
    }
    this.jobWatches.set(id, updated)
    this.touchTaskGroup(current.taskGroupId, timestamp)
    this.persist()
    return updated
  }

  recoverAgainstSessions(activeSessionIds: ReadonlySet<string>): StoreRecoveryResult {
    let activeAgents = 0
    let missingAgents = 0
    let resetAgents = 0
    const timestamp = new Date().toISOString()

    for (const [agentId, agent] of this.agents) {
      if (agent.role === "APPROVER" && agent.opencodeSessionId.startsWith("logical-approver:")) {
        activeAgents += 1
        continue
      }
      if (!activeSessionIds.has(agent.opencodeSessionId)) {
        missingAgents += 1
        this.agents.set(agentId, {
          ...agent,
          lifecycleStatus: "FAILED",
          lastError: "OpenCode Session was not found during startup recovery.",
          updatedAt: timestamp,
        })
        for (const [taskId, task] of this.workerTasks) {
          if (task.workerAgentId === agentId && ["PENDING", "STARTING", "RUNNING"].includes(task.status)) {
            this.workerTasks.set(taskId, {
              ...task,
              status: "FAILED",
              error: "OpenCode Session was not found during startup recovery.",
              updatedAt: timestamp,
            })
          }
        }
        if (agent.role === "MAIN") {
          const taskGroup = this.taskGroups.get(agent.taskGroupId)
          if (taskGroup !== undefined) {
            this.taskGroups.set(taskGroup.id, { ...taskGroup, status: "FAILED", updatedAt: timestamp })
          }
        }
        continue
      }

      activeAgents += 1
      if (agent.lifecycleStatus === "CREATING" || agent.lifecycleStatus === "RUNNING") {
        resetAgents += 1
        this.agents.set(agentId, { ...agent, lifecycleStatus: "READY", updatedAt: timestamp })
      }
    }
    this.persist()
    return { activeAgents, missingAgents, resetAgents }
  }

  getStats(): {
    taskGroups: number
    agents: number
    workerTasks: number
    permissions: number
    auditRecords: number
    agentQuestions: number
    changeReviews: number
    jobWatches: number
  } {
    return {
      taskGroups: this.taskGroups.size,
      agents: this.agents.size,
      workerTasks: this.workerTasks.size,
      permissions: this.permissionRequests.size,
      auditRecords: this.auditRecords.length,
      agentQuestions: this.agentQuestions.size,
      changeReviews: this.changeReviews.size,
      jobWatches: this.jobWatches.size,
    }
  }

  close(): void {
    // Persistent stores override this method.
  }
}
