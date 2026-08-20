import type { ControlPlaneConfig } from "./config.ts"
import type { EventHub } from "./event-hub.ts"
import type {
  OpenCodeAdapter,
  OpenCodePermissionDecision,
  OpenCodePermissionRequest,
} from "./opencode-adapter.ts"
import { approvalAgentSystem } from "./agent-prompts.ts"
import {
  InMemoryStore,
  type AgentInstance,
  type PermissionDecisionSource,
  type PermissionRequestRecord,
  type PermissionRisk,
} from "./store.ts"

export type PermissionReview = "approve_once" | "reject" | "escalate"

interface PolicyResult {
  risk: PermissionRisk
  decision?: OpenCodePermissionDecision
  rationale: string
  askApprovalAgent: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function permissionText(request: OpenCodePermissionRequest): string {
  return [
    ...(request.resources ?? []),
    ...(request.patterns ?? []),
    JSON.stringify(request.metadata ?? {}),
  ].join("\n")
}

function evaluatePolicy(agent: AgentInstance, request: OpenCodePermissionRequest): PolicyResult {
  const action = (request.action ?? request.permission ?? "unknown").toLowerCase()
  const details = permissionText(request)
  const destructive = [
    /\brm\s+[^\n]*(?:-rf|-fr|--recursive)/i,
    /(^|\s)git\s+(?:reset\s+--hard|clean\s+-[a-z]*[fd])/i,
    /\b(?:drop|truncate|delete\s+from|update\s+\S+\s+set|insert\s+into|alter\s+table)\b/i,
  ].some((pattern) => pattern.test(details))

  if (destructive) {
    return {
      risk: "CRITICAL",
      decision: "reject",
      rationale: "命令包含删除、强制 Git 操作或写数据库行为，静态规则直接拒绝。",
      askApprovalAgent: false,
    }
  }

  if (["read", "grep", "glob", "list", "skill"].includes(action)) {
    return {
      risk: "LOW",
      decision: agent.role === "APPROVER" ? undefined : "once",
      rationale: agent.role === "APPROVER" ? "审批 Agent 不应执行项目读取操作，等待人工确认。" : "只读工作区操作，允许本次执行。",
      askApprovalAgent: false,
    }
  }

  if (action === "bash") {
    const metadataCommand = typeof request.metadata?.command === "string" ? request.metadata.command : undefined
    const commands = [
      ...(request.resources ?? []),
      ...(request.patterns ?? []),
      ...(metadataCommand === undefined ? [] : [metadataCommand]),
    ]
    const safeCommand =
      commands.length > 0 &&
      commands.every((command) =>
        /^(?:\s*)(?:pwd|ls|rg|grep|find|sed|head|tail|cat|git\s+(?:status|diff|log|show))(?:\s|$)/i.test(
          command,
        ),
      )
    if (safeCommand && agent.role !== "APPROVER") {
      return {
        risk: "LOW",
        decision: "once",
        rationale: "命令匹配只读查询白名单，允许本次执行。",
        askApprovalAgent: false,
      }
    }
    return {
      risk: "HIGH",
      rationale: agent.role === "APPROVER" ? "审批 Agent 不应执行命令，等待人工确认。" : "未命中只读命令白名单，交给审批 Agent 判断。",
      askApprovalAgent: agent.role !== "APPROVER",
    }
  }

  if (["external_directory", "webfetch", "websearch"].includes(action)) {
    return {
      risk: "HIGH",
      rationale: agent.role === "APPROVER" ? "审批 Agent 的额外访问需要人工确认。" : "操作会访问当前工作区之外的资源，交给审批 Agent 判断。",
      askApprovalAgent: agent.role !== "APPROVER",
    }
  }

  return {
    risk: "MEDIUM",
    rationale: agent.role === "APPROVER"
      ? "审批 Agent 自身的未知权限必须由人工确认。"
      : "未知且未命中静态规则，交给专用审批 Agent 给出结构化决定。",
    askApprovalAgent: agent.role !== "APPROVER",
  }
}

function normalizeEventRequest(event: Record<string, unknown>): OpenCodePermissionRequest | undefined {
  if (!["permission.asked", "permission.v2.asked"].includes(String(event.type))) return undefined
  const payload = record(event.properties) ?? record(event.data) ?? record(event.payload)
  if (payload === undefined || typeof payload.id !== "string" || typeof payload.sessionID !== "string") return undefined
  return {
    id: payload.id,
    sessionID: payload.sessionID,
    permission: typeof payload.permission === "string" ? payload.permission : undefined,
    patterns: strings(payload.patterns),
    always: strings(payload.always),
    action: typeof payload.action === "string" ? payload.action : undefined,
    resources: strings(payload.resources),
    save: strings(payload.save),
    metadata: record(payload.metadata),
    source: record(payload.source),
    tool: record(payload.tool),
  }
}

export class PermissionManager {
  private readonly inflight = new Map<string, Promise<PermissionRequestRecord>>()
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

  async syncPending(): Promise<void> {
    const pending = await this.adapter.listPendingPermissions()
    for (const request of pending) await this.ingest(request)
  }

  async handleOpenCodeEvent(value: unknown): Promise<void> {
    const event = record(value)
    if (event === undefined) return
    const request = normalizeEventRequest(event)
    if (request !== undefined) {
      await this.ingest(request)
      return
    }

    if (!["permission.replied", "permission.v2.replied"].includes(String(event.type))) return
    const payload = record(event.properties) ?? record(event.data) ?? record(event.payload)
    if (
      payload === undefined ||
      typeof payload.sessionID !== "string" ||
      typeof payload.requestID !== "string" ||
      !["once", "always", "reject"].includes(String(payload.reply))
    ) {
      return
    }
    const current = this.store.getPermissionRequestByExternal(payload.sessionID, payload.requestID)
    if (current === undefined || current.status !== "PENDING") return
    const resolved = this.store.resolvePermissionRequest({
      id: current.id,
      decision: payload.reply as OpenCodePermissionDecision,
      source: "EXTERNAL",
      rationale: "OpenCode 事件报告该权限已在其他客户端处理。",
    })
    if (resolved !== undefined) this.afterResolution(resolved)
  }

  async ingest(request: OpenCodePermissionRequest): Promise<PermissionRequestRecord | undefined> {
    const agent = this.store.getAgentBySession(request.sessionID)
    if (agent === undefined) return undefined
    const policy = evaluatePolicy(agent, request)
    const action = request.action ?? request.permission ?? "unknown"
    const resources = request.resources ?? request.patterns ?? []
    const result = this.store.upsertPermissionRequest({
      agent,
      opencodeRequestId: request.id,
      action,
      resources,
      metadata: request.metadata ?? {},
      risk: policy.risk,
    })
    if (!result.created) return result.permission

    this.store.setAgentStatus(agent.id, "WAITING_APPROVAL")
    this.store.appendAudit({
      type: "permission.requested",
      taskGroupId: agent.taskGroupId,
      agentId: agent.id,
      permissionId: result.permission.id,
      data: { action, resources, risk: policy.risk, policy: policy.rationale },
    })
    this.events.publish("permission.requested", result.permission)

    if (policy.decision !== undefined) {
      try {
        const resolved = await this.decide(
          result.permission.id,
          policy.decision,
          "STATIC_POLICY",
          policy.rationale,
        )
        return resolved
      } catch (error) {
        this.recordDecisionError(result.permission, error)
        return this.store.getPermissionRequest(result.permission.id)
      }
    }

    if (policy.askApprovalAgent) await this.requestApprovalReview(result.permission)
    return this.store.getPermissionRequest(result.permission.id)
  }

  async decide(
    permissionId: string,
    decision: OpenCodePermissionDecision,
    source: PermissionDecisionSource,
    rationale?: string,
  ): Promise<PermissionRequestRecord> {
    const existing = this.inflight.get(permissionId)
    if (existing !== undefined) return existing
    const operation = this.performDecision(permissionId, decision, source, rationale)
    this.inflight.set(permissionId, operation)
    try {
      return await operation
    } finally {
      this.inflight.delete(permissionId)
    }
  }

  async applyApprovalReview(input: {
    permissionId: string
    callerSessionId: string
    review: PermissionReview
    reason: string
  }): Promise<PermissionRequestRecord> {
    const permission = this.store.getPermissionRequest(input.permissionId)
    if (permission === undefined) throw new Error("PERMISSION_NOT_FOUND")
    const caller = this.store.getAgentBySession(input.callerSessionId)
    if (caller?.role !== "APPROVER" || caller.taskGroupId !== permission.taskGroupId) {
      throw new Error("CALLER_IS_NOT_PERMISSION_APPROVAL_AGENT")
    }
    if (permission.status !== "PENDING") return permission

    if (input.review === "escalate") {
      this.store.appendAudit({
        type: "permission.approval_agent_escalated",
        taskGroupId: permission.taskGroupId,
        agentId: permission.agentId,
        permissionId: permission.id,
        data: { reason: input.reason },
      })
      this.events.publish("permission.awaiting_human", { permission, reason: input.reason })
      return permission
    }

    const decision: OpenCodePermissionDecision = input.review === "reject" ? "reject" : "once"
    return this.decide(permission.id, decision, "APPROVAL_AGENT", input.reason)
  }

  private async performDecision(
    permissionId: string,
    decision: OpenCodePermissionDecision,
    source: PermissionDecisionSource,
    rationale?: string,
  ): Promise<PermissionRequestRecord> {
    const permission = this.store.getPermissionRequest(permissionId)
    if (permission === undefined) throw new Error("PERMISSION_NOT_FOUND")
    if (permission.status !== "PENDING") return permission
    if (decision === "always" && source !== "HUMAN") throw new Error("ALWAYS_REQUIRES_HUMAN")

    await this.adapter.replyPermission({
      sessionId: permission.opencodeSessionId,
      requestId: permission.opencodeRequestId,
      decision,
      message: rationale,
    })
    const resolved = this.store.resolvePermissionRequest({ id: permission.id, decision, source, rationale })
    if (resolved === undefined) throw new Error("PERMISSION_NOT_FOUND")
    this.afterResolution(resolved)
    return resolved
  }

  private afterResolution(permission: PermissionRequestRecord): void {
    const agent = this.store.getAgent(permission.agentId)
    if (agent !== undefined && !this.store.hasPendingPermissionsForAgent(agent.id)) {
      this.store.setAgentStatus(agent.id, "RUNNING")
    }
    this.store.appendAudit({
      type: "permission.resolved",
      taskGroupId: permission.taskGroupId,
      agentId: permission.agentId,
      permissionId: permission.id,
      data: {
        decision: permission.decision,
        source: permission.decisionSource,
        rationale: permission.rationale,
      },
    })
    this.events.publish("permission.resolved", permission)
  }

  private async requestApprovalReview(permission: PermissionRequestRecord): Promise<void> {
    const group = this.store.getTaskGroup(permission.taskGroupId)
    const approver = group?.agents.find((agent) => agent.role === "APPROVER")
    if (approver === undefined) {
      this.events.publish("permission.awaiting_human", { permission, reason: "任务组没有可用的审批 Agent。" })
      return
    }
    this.store.markPermissionReviewRequested(permission.id)
    this.store.appendAudit({
      type: "permission.approval_agent_requested",
      taskGroupId: permission.taskGroupId,
      agentId: permission.agentId,
      permissionId: permission.id,
      data: { approvalAgentId: approver.id },
    })
    try {
      await this.adapter.sendAsync(approver.opencodeSessionId, {
        agent: approver.opencodeAgentName,
        model: this.config.opencodeModel,
        system: approvalAgentSystem,
        text: [
          "An Agent is waiting for permission review.",
          `Control Plane permission ID: ${permission.id}`,
          `Action: ${permission.action}`,
          `Resources: ${JSON.stringify(permission.resources)}`,
          `Metadata: ${JSON.stringify(permission.metadata)}`,
          `Risk: ${permission.risk}`,
          "Call review_permission with your decision and a concise reason.",
        ].join("\n"),
      })
      this.events.publish("permission.approval_agent_requested", permission)
    } catch (error) {
      this.recordDecisionError(permission, error)
    }
  }

  private recordDecisionError(permission: PermissionRequestRecord, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.store.appendAudit({
      type: "permission.decision_error",
      taskGroupId: permission.taskGroupId,
      agentId: permission.agentId,
      permissionId: permission.id,
      data: { error: message },
    })
    this.events.publish("permission.decision_error", { permissionId: permission.id, error: message })
  }
}
