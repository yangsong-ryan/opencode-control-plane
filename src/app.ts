import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { randomUUID } from "node:crypto"
import type { AddressInfo } from "node:net"
import type { ControlPlaneConfig } from "./config.ts"
import { EventHub } from "./event-hub.ts"
import { AgentCommunicationManager } from "./agent-communication-manager.ts"
import {
  approvalAgentSystem,
  approvalAgentTools,
  mainAgentSystem,
  mainAgentTools,
  workerAgentSystem,
  workerAgentTools,
} from "./agent-prompts.ts"
import { renderHomePage } from "./home-page.ts"
import { OpenCodeAdapter, OpenCodeHttpError, type OpenCodeCapabilities } from "./opencode-adapter.ts"
import { Orchestrator } from "./orchestrator.ts"
import { SqliteStore } from "./sqlite-store.ts"
import {
  approverSessionPermissionRules,
  mainSessionPermissionRules,
  PermissionManager,
  type PermissionReview,
} from "./permission-manager.ts"
import {
  InMemoryStore,
  type PermissionDecision,
  type PermissionStatus,
  type WorkerTaskInput,
} from "./store.ts"

interface ApplicationOptions {
  config: ControlPlaneConfig
  adapter?: OpenCodeAdapter
  store?: InMemoryStore
}

interface JsonError {
  error: { code: string; message: string; details?: unknown }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  })
  response.end(body)
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  })
  response.end(body)
}

function sendError(response: ServerResponse, status: number, code: string, message: string, details?: unknown): void {
  const payload: JsonError = { error: { code, message, details } }
  sendJson(response, status, payload)
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > maxBytes) throw new Error("REQUEST_TOO_LARGE")
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("JSON_OBJECT_REQUIRED")
  }
  return parsed as Record<string, unknown>
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`INVALID_${name.toUpperCase()}`)
  return value.trim()
}

function workerTaskInputs(value: unknown): WorkerTaskInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) throw new Error("INVALID_TASKS")
  return value.map((item, index) => {
    if (item === null || Array.isArray(item) || typeof item !== "object") throw new Error("INVALID_TASKS")
    const record = item as Record<string, unknown>
    return {
      fieldKey: requiredString(record.field_key ?? record.fieldKey, `tasks_${index}_field_key`),
      title: requiredString(record.title, `tasks_${index}_title`),
      prompt: requiredString(record.prompt, `tasks_${index}_prompt`),
    }
  })
}

function permissionDecision(value: unknown): PermissionDecision {
  if (value !== "once" && value !== "always" && value !== "reject") throw new Error("INVALID_DECISION")
  return value
}

function permissionReview(value: unknown): PermissionReview {
  if (value !== "approve_once" && value !== "reject" && value !== "escalate") {
    throw new Error("INVALID_REVIEW")
  }
  return value
}

function emptyAssistantWarning(messages: Array<{ info?: Record<string, unknown>; parts?: unknown[] }>): string | undefined {
  const last = messages.at(-1)
  if (last?.info?.role !== "assistant") return undefined
  if (last.info.error !== undefined) {
    const error = last.info.error
    if (typeof error === "string") return `OpenCode 模型调用失败：${error}`
    if (error !== null && typeof error === "object") {
      const value = error as Record<string, unknown>
      const data = value.data !== null && typeof value.data === "object" ? value.data as Record<string, unknown> : undefined
      const message = data?.message ?? value.message ?? value.name
      if (typeof message === "string") return `OpenCode 模型调用失败：${message}`
      return `OpenCode 模型调用失败：${JSON.stringify(error)}`
    }
  }
  if ((last.parts?.length ?? 0) > 0) return undefined
  const tokens = last.info.tokens as { output?: number } | undefined
  if (tokens?.output === 0) {
    return "OpenCode 已结束本轮运行，但模型返回了零 token 和空内容。请配置一个可用模型后重试。"
  }
  return undefined
}

function requiredRoutesAvailable(capabilities: OpenCodeCapabilities): boolean {
  const routes = capabilities.routes
  return (
    capabilities.healthy &&
    routes.createSession &&
    routes.listSessions &&
    routes.listMessages &&
    routes.promptAsync &&
    routes.abortSession &&
    routes.events
  )
}

export function createApplication(options: ApplicationOptions) {
  const adapter =
    options.adapter ??
    new OpenCodeAdapter({
      baseUrl: options.config.opencodeBaseUrl,
      directory: options.config.opencodeDirectory,
      username: options.config.opencodeUsername,
      password: options.config.opencodePassword,
    })
  const store = options.store ?? new SqliteStore(options.config.databasePath)
  const events = new EventHub()
  const orchestrator = new Orchestrator(store, adapter, events, options.config)
  const permissionManager = new PermissionManager(store, adapter, events, options.config)
  const communicationManager = new AgentCommunicationManager(store, adapter, events, options.config)
  const relayController = new AbortController()
  let capabilities: OpenCodeCapabilities | undefined
  let initialized = false
  let stopping = false
  let relayTask: Promise<void> | undefined
  let recovery: { activeAgents: number; missingAgents: number; resetAgents: number } | undefined

  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? "GET"
    const url = new URL(request.url ?? "/", "http://control-plane.local")

    if (method === "GET" && url.pathname === "/") {
      const ready = capabilities !== undefined && requiredRoutesAvailable(capabilities)
      const version = capabilities?.version ?? "正在初始化"
      sendHtml(
        response,
        200,
        renderHomePage({ ready, version }),
      )
      return
    }

    if (method === "GET" && url.pathname === "/health") {
      sendJson(response, capabilities !== undefined && requiredRoutesAvailable(capabilities) ? 200 : 503, {
        ready: capabilities !== undefined && requiredRoutesAvailable(capabilities),
        opencode: capabilities,
        runtime: {
          directory: options.config.opencodeDirectory,
          model: options.config.opencodeModel ?? "OpenCode default",
        },
        storage: { databasePath: options.config.databasePath, stats: store.getStats(), recovery },
      })
      return
    }

    if (method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      })
      events.addClient(response)
      return
    }

    if (method === "GET" && url.pathname === "/api/permissions") {
      const statusValue = url.searchParams.get("status") ?? undefined
      const status =
        statusValue !== undefined && ["PENDING", "APPROVED", "REJECTED", "FAILED"].includes(statusValue)
          ? (statusValue as PermissionStatus)
          : undefined
      if (statusValue !== undefined && status === undefined) throw new Error("INVALID_STATUS")
      sendJson(response, 200, {
        items: store.listPermissionRequests({
          taskGroupId: url.searchParams.get("task_group_id") ?? undefined,
          status,
        }),
      })
      return
    }

    if (method === "GET" && url.pathname === "/api/audit") {
      const parsedLimit = Number(url.searchParams.get("limit") ?? "100")
      const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 500) : 100
      sendJson(response, 200, { items: store.listAuditRecords(limit) })
      return
    }

    if (method === "GET" && url.pathname === "/api/agent-questions") {
      const statusValue = url.searchParams.get("status") ?? undefined
      if (statusValue !== undefined && !["OPEN", "ANSWERED"].includes(statusValue)) throw new Error("INVALID_STATUS")
      sendJson(response, 200, {
        items: store.listAgentQuestions({
          taskGroupId: url.searchParams.get("task_group_id") ?? undefined,
          status: statusValue as "OPEN" | "ANSWERED" | undefined,
        }),
      })
      return
    }

    const permissionDecisionMatch = url.pathname.match(/^\/api\/permissions\/([^/]+)\/decision$/)
    if (method === "POST" && permissionDecisionMatch !== null) {
      const body = await readJson(request, options.config.maxRequestBytes)
      const permissionId = decodeURIComponent(permissionDecisionMatch[1])
      const current = store.getPermissionRequest(permissionId)
      if (current === undefined) {
        sendError(response, 404, "PERMISSION_NOT_FOUND", "Permission request not found")
        return
      }
      const resolved = await permissionManager.decide(
        permissionId,
        permissionDecision(body.decision),
        "HUMAN",
        typeof body.rationale === "string" ? body.rationale : "人工在权限中心完成审批。",
      )
      sendJson(response, 200, resolved)
      return
    }

    if (method === "POST" && url.pathname === "/api/task-groups") {
      const body = await readJson(request, options.config.maxRequestBytes)
      const title = requiredString(body.title, "title")
      const session = await adapter.createSession({
        title,
        model: options.config.opencodeModel,
        permission: mainSessionPermissionRules,
      })
      const approvalSession = await adapter.createSession({
        title: `${title} / 权限审批`,
        parentSessionId: session.id,
        model: options.config.opencodeModel,
        permission: approverSessionPermissionRules,
      })
      const created = store.createTaskGroup({ title, sessionId: session.id })
      const approver = store.attachApprover({
        taskGroupId: created.taskGroup.id,
        parentAgentId: created.agent.id,
        sessionId: approvalSession.id,
      })
      const result = { ...created, approver }
      events.publish("task_group.created", result)
      sendJson(response, 201, result)
      return
    }

    if (method === "GET" && url.pathname === "/api/task-groups") {
      sendJson(response, 200, { items: store.listTaskGroups() })
      return
    }

    const workersMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/workers$/)
    if (method === "POST" && workersMatch !== null) {
      const taskGroupId = decodeURIComponent(workersMatch[1])
      const group = store.getTaskGroup(taskGroupId)
      if (group === undefined) {
        sendError(response, 404, "TASK_GROUP_NOT_FOUND", "Task group not found")
        return
      }
      const mainAgent = group.agents.find((agent) => agent.id === group.taskGroup.rootAgentId)
      if (mainAgent === undefined) throw new Error("MAIN_AGENT_NOT_FOUND")
      const body = await readJson(request, options.config.maxRequestBytes)
      const result = await orchestrator.spawnWorkers({
        taskGroupId,
        callerSessionId: mainAgent.opencodeSessionId,
        requestId: typeof body.request_id === "string" && body.request_id !== "" ? body.request_id : randomUUID(),
        tasks: workerTaskInputs(body.tasks),
      })
      sendJson(response, result.idempotent ? 200 : 201, result)
      return
    }

    if (method === "POST" && url.pathname === "/internal/orchestrator/spawn-workers") {
      if (options.config.toolToken !== undefined && request.headers["x-control-plane-token"] !== options.config.toolToken) {
        sendError(response, 401, "INVALID_TOOL_TOKEN", "Invalid Control Plane tool token")
        return
      }
      const body = await readJson(request, options.config.maxRequestBytes)
      const callerSessionId = requiredString(body.caller_session_id, "caller_session_id")
      const caller = store.getAgentBySession(callerSessionId)
      if (caller === undefined || caller.role !== "MAIN") {
        sendError(response, 403, "CALLER_IS_NOT_MAIN_AGENT", "Only a registered main Agent can spawn workers")
        return
      }
      const result = await orchestrator.spawnWorkers({
        taskGroupId: caller.taskGroupId,
        callerSessionId,
        requestId: requiredString(body.request_id, "request_id"),
        tasks: workerTaskInputs(body.tasks),
      })
      sendJson(response, result.idempotent ? 200 : 201, result)
      return
    }

    if (method === "POST" && url.pathname === "/internal/orchestrator/permission-reviews") {
      if (options.config.toolToken !== undefined && request.headers["x-control-plane-token"] !== options.config.toolToken) {
        sendError(response, 401, "INVALID_TOOL_TOKEN", "Invalid Control Plane tool token")
        return
      }
      const body = await readJson(request, options.config.maxRequestBytes)
      const result = await permissionManager.applyApprovalReview({
        permissionId: requiredString(body.permission_id, "permission_id"),
        callerSessionId: requiredString(body.caller_session_id, "caller_session_id"),
        review: permissionReview(body.review),
        reason: requiredString(body.reason, "reason"),
      })
      sendJson(response, 200, result)
      return
    }

    if (method === "POST" && url.pathname === "/internal/orchestrator/ask-main") {
      if (options.config.toolToken !== undefined && request.headers["x-control-plane-token"] !== options.config.toolToken) {
        sendError(response, 401, "INVALID_TOOL_TOKEN", "Invalid Control Plane tool token")
        return
      }
      const body = await readJson(request, options.config.maxRequestBytes)
      const result = await communicationManager.askMain({
        callerSessionId: requiredString(body.caller_session_id, "caller_session_id"),
        question: requiredString(body.question, "question"),
        context: typeof body.context === "string" && body.context.trim() !== "" ? body.context.trim() : undefined,
      })
      sendJson(response, 201, result)
      return
    }

    if (method === "POST" && url.pathname === "/internal/orchestrator/answer-worker") {
      if (options.config.toolToken !== undefined && request.headers["x-control-plane-token"] !== options.config.toolToken) {
        sendError(response, 401, "INVALID_TOOL_TOKEN", "Invalid Control Plane tool token")
        return
      }
      const body = await readJson(request, options.config.maxRequestBytes)
      const result = await communicationManager.answerWorker({
        callerSessionId: requiredString(body.caller_session_id, "caller_session_id"),
        questionId: requiredString(body.question_id, "question_id"),
        answer: requiredString(body.answer, "answer"),
      })
      sendJson(response, 200, result)
      return
    }

    if (method === "POST" && url.pathname === "/internal/orchestrator/list-workers") {
      if (options.config.toolToken !== undefined && request.headers["x-control-plane-token"] !== options.config.toolToken) {
        sendError(response, 401, "INVALID_TOOL_TOKEN", "Invalid Control Plane tool token")
        return
      }
      const body = await readJson(request, options.config.maxRequestBytes)
      sendJson(response, 200, {
        items: communicationManager.listWorkers(requiredString(body.caller_session_id, "caller_session_id")),
      })
      return
    }

    if (method === "POST" && url.pathname === "/internal/orchestrator/message-worker") {
      if (options.config.toolToken !== undefined && request.headers["x-control-plane-token"] !== options.config.toolToken) {
        sendError(response, 401, "INVALID_TOOL_TOKEN", "Invalid Control Plane tool token")
        return
      }
      const body = await readJson(request, options.config.maxRequestBytes)
      const result = await communicationManager.messageWorker({
        callerSessionId: requiredString(body.caller_session_id, "caller_session_id"),
        workerAgentId: requiredString(body.worker_agent_id, "worker_agent_id"),
        message: requiredString(body.message, "message"),
      })
      sendJson(response, 202, result)
      return
    }

    const taskGroupMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)$/)
    if (method === "GET" && taskGroupMatch !== null) {
      const result = store.getTaskGroup(decodeURIComponent(taskGroupMatch[1]))
      if (result === undefined) {
        sendError(response, 404, "TASK_GROUP_NOT_FOUND", "Task group not found")
        return
      }
      sendJson(response, 200, result)
      return
    }

    const agentMessagesMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/messages$/)
    if (agentMessagesMatch !== null) {
      const agentId = decodeURIComponent(agentMessagesMatch[1])
      const agent = store.getAgent(agentId)
      if (agent === undefined) {
        sendError(response, 404, "AGENT_NOT_FOUND", "Agent not found")
        return
      }

      if (method === "GET") {
        const messages = await adapter.listMessages(agent.opencodeSessionId)
        sendJson(response, 200, { items: messages, agent, warning: emptyAssistantWarning(messages) })
        return
      }

      if (method === "POST") {
        const body = await readJson(request, options.config.maxRequestBytes)
        const text = requiredString(body.text, "text")
        const runId = randomUUID()
        store.setAgentStatus(agent.id, "RUNNING")
        const system = agent.role === "MAIN"
          ? mainAgentSystem
          : agent.role === "WORKER"
            ? workerAgentSystem
            : approvalAgentSystem
        const tools = agent.role === "MAIN"
          ? mainAgentTools
          : agent.role === "WORKER"
            ? workerAgentTools
            : approvalAgentTools
        await adapter.sendAsync(agent.opencodeSessionId, { text, model: options.config.opencodeModel, system, tools })
        events.publish("agent.message.accepted", { agentId, runId })
        sendJson(response, 202, { accepted: true, runId })
        return
      }
    }

    const agentAbortMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/abort$/)
    if (method === "POST" && agentAbortMatch !== null) {
      const agentId = decodeURIComponent(agentAbortMatch[1])
      const agent = store.getAgent(agentId)
      if (agent === undefined) {
        sendError(response, 404, "AGENT_NOT_FOUND", "Agent not found")
        return
      }
      const aborted = await adapter.abortSession(agent.opencodeSessionId)
      store.setAgentStatus(agent.id, "CANCELLED")
      events.publish("agent.aborted", { agentId, aborted })
      sendJson(response, 200, { aborted })
      return
    }

    sendError(response, 404, "NOT_FOUND", "Route not found")
  }

  const safeHandleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    await handleRequest(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined)
        return
      }
      if (error instanceof OpenCodeHttpError) {
        sendError(response, 502, "OPENCODE_ERROR", error.message, {
          status: error.status,
          body: error.body,
        })
        return
      }
      if (error instanceof SyntaxError) {
        sendError(response, 400, "INVALID_JSON", "Request body must be valid JSON")
        return
      }
      if (error instanceof Error && error.message === "REQUEST_TOO_LARGE") {
        sendError(response, 413, "REQUEST_TOO_LARGE", "Request body is too large")
        return
      }
      if (error instanceof Error && error.message.startsWith("INVALID_")) {
        sendError(response, 400, error.message, "A required field is missing or invalid")
        return
      }
      if (error instanceof Error && error.message === "PERMISSION_NOT_FOUND") {
        sendError(response, 404, error.message, "Permission request not found")
        return
      }
      if (error instanceof Error && error.message === "CALLER_IS_NOT_PERMISSION_APPROVAL_AGENT") {
        sendError(response, 403, error.message, "Only this task group's approval Agent can submit this review")
        return
      }
      if (error instanceof Error && error.message === "ALWAYS_REQUIRES_HUMAN") {
        sendError(response, 400, error.message, "Only a human may grant an always permission")
        return
      }
      if (error instanceof Error && error.message === "JSON_OBJECT_REQUIRED") {
        sendError(response, 400, "JSON_OBJECT_REQUIRED", "Request body must be a JSON object")
        return
      }
      if (error instanceof Error && (error.message.startsWith("CALLER_IS_NOT_") || error.message.includes("DOES_NOT_BELONG"))) {
        sendError(response, 403, error.message, "This Agent is not allowed to perform that task-group action")
        return
      }
      if (error instanceof Error && error.message.endsWith("_NOT_FOUND")) {
        sendError(response, 404, error.message, "The requested Control Plane resource was not found")
        return
      }
      sendError(response, 500, "INTERNAL_ERROR", error instanceof Error ? error.message : "Unknown error")
    })
  }

  const server: Server = createServer((request, response) => {
    void safeHandleRequest(request, response)
  })

  const runEventRelay = async (): Promise<void> => {
    let retryMs = 250
    while (!relayController.signal.aborted) {
      try {
        await adapter.subscribeEvents(async (event) => {
          await permissionManager.handleOpenCodeEvent(event)
          if (event !== null && typeof event === "object") {
            const record = event as Record<string, unknown>
            const properties = (record.properties ?? record.payload) as Record<string, unknown> | undefined
            const sessionId = properties?.sessionID
            const agent = typeof sessionId === "string" ? store.getAgentBySession(sessionId) : undefined
            if (agent !== undefined) {
              if (record.type === "session.idle") store.setAgentStatus(agent.id, "IDLE")
              if (record.type === "session.error") {
                store.setAgentStatus(agent.id, "FAILED", JSON.stringify(properties?.error ?? properties ?? {}))
              }
              if (record.type === "session.status") {
                const status = properties?.status as { type?: string } | undefined
                if (status?.type === "busy" || status?.type === "retry") store.setAgentStatus(agent.id, "RUNNING")
                if (status?.type === "idle") store.setAgentStatus(agent.id, "IDLE")
              }
            }
          }
          events.publish("opencode.event", event)
        }, relayController.signal)
        retryMs = 250
      } catch (error) {
        if (relayController.signal.aborted) break
        events.publish("opencode.reconnecting", {
          retryMs,
          error: error instanceof Error ? error.message : String(error),
        })
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, retryMs)
          relayController.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timeout)
              resolve()
            },
            { once: true },
          )
        })
        retryMs = Math.min(retryMs * 2, 5_000)
      }
    }
  }

  const initialize = async (): Promise<void> => {
    if (initialized) return
    capabilities = await adapter.probeCapabilities()
    if (!requiredRoutesAvailable(capabilities)) {
      throw new Error(`OpenCode is missing required capabilities: ${JSON.stringify(capabilities.routes)}`)
    }
    const sessions = await adapter.listSessions()
    recovery = store.recoverAgainstSessions(new Set(sessions.map((session) => session.id)))
    if (store.getStats().agents > 0) {
      store.appendAudit({ type: "storage.recovered", data: { ...recovery } })
    }
    if (capabilities.routes.permissionList && capabilities.routes.permissionReply) {
      await permissionManager.syncPending()
    }
    initialized = true
  }

  return {
    server,
    store,
    permissionManager,
    handleRequest: safeHandleRequest,
    get capabilities() {
      return capabilities
    },
    initialize,
    async start(input: { host?: string; port?: number } = {}): Promise<{ host: string; port: number }> {
      await initialize()
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(input.port ?? options.config.port, input.host ?? options.config.host, () => {
          server.off("error", reject)
          resolve()
        })
      })
      relayTask = runEventRelay()
      const address = server.address() as AddressInfo
      return { host: address.address, port: address.port }
    },
    async stop(): Promise<void> {
      if (stopping) return
      stopping = true
      relayController.abort()
      events.close()
      server.closeAllConnections()
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
      await relayTask?.catch(() => undefined)
      store.close()
    },
  }
}
