import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"
import type { IncomingMessage, ServerResponse } from "node:http"
import { Readable, Writable } from "node:stream"
import { test } from "node:test"
import { createApplication } from "../src/app.ts"
import { loadConfig, type ControlPlaneConfig } from "../src/config.ts"
import { EventHub } from "../src/event-hub.ts"
import {
  OpenCodeAdapter,
  OpenCodeConnectionError,
  type OpenCodeCapabilities,
  type OpenCodeMessage,
  type OpenCodePermissionDecision,
  type OpenCodePermissionRule,
  type OpenCodePermissionRequest,
  type OpenCodeSession,
  type SendMessageInput,
} from "../src/opencode-adapter.ts"
import { formatStartupError } from "../src/diagnostics.ts"
import { SqliteStore } from "../src/sqlite-store.ts"

class FakeRequest extends Readable {
  method: string
  url: string
  private readonly content: Buffer
  private sent = false

  constructor(method: string, path: string, body?: unknown) {
    super()
    this.method = method
    this.url = path
    this.content = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  }

  _read(): void {
    if (this.sent) return
    this.sent = true
    if (this.content.length > 0) this.push(this.content)
    this.push(null)
  }
}

class FakeResponse extends Writable {
  statusCode = 200
  headersSent = false
  readonly headers = new Map<string, string | number | readonly string[]>()
  readonly chunks: Buffer[] = []

  writeHead(statusCode: number, headers?: Record<string, string | number | readonly string[]>): this {
    this.statusCode = statusCode
    this.headersSent = true
    for (const [key, value] of Object.entries(headers ?? {})) this.headers.set(key.toLowerCase(), value)
    return this
  }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    callback()
  }

  get text(): string {
    return Buffer.concat(this.chunks).toString("utf8")
  }

  get json(): unknown {
    return JSON.parse(this.text)
  }
}

class FakeAdapter {
  readonly prompts: Array<{ sessionId: string; input: SendMessageInput }> = []
  readonly sessions: OpenCodeSession[] = []
  readonly sessionInputs: Array<{
    title: string
    parentSessionId?: string
    model?: { providerID: string; modelID: string }
    permission?: OpenCodePermissionRule[]
  }> = []
  readonly pendingPermissions: OpenCodePermissionRequest[] = []
  readonly permissionReplies: Array<{
    sessionId: string
    requestId: string
    decision: OpenCodePermissionDecision
    message?: string
  }> = []
  abortCount = 0
  activeCreates = 0
  maxActiveCreates = 0
  private nextSession = 1
  private readonly createDelayMs: number

  constructor(createDelayMs = 0) {
    this.createDelayMs = createDelayMs
  }

  resetCreateMetrics(): void {
    this.activeCreates = 0
    this.maxActiveCreates = 0
  }

  async probeCapabilities(): Promise<OpenCodeCapabilities> {
    return {
      healthy: true,
      version: "1.17.15-test",
      routes: {
        createSession: true,
        listSessions: true,
        listMessages: true,
        promptAsync: true,
        abortSession: true,
        events: true,
        permissionList: true,
        permissionReply: true,
        v2PermissionReply: true,
      },
    }
  }

  async createSession(input: {
    title: string
    parentSessionId?: string
    model?: { providerID: string; modelID: string }
    permission?: OpenCodePermissionRule[]
  }): Promise<OpenCodeSession> {
    this.sessionInputs.push(input)
    const id = `ses_${this.nextSession++}`
    this.activeCreates += 1
    this.maxActiveCreates = Math.max(this.maxActiveCreates, this.activeCreates)
    try {
      if (this.createDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.createDelayMs))
      const session = { id, title: input.title, parentID: input.parentSessionId }
      this.sessions.push(session)
      return session
    } finally {
      this.activeCreates -= 1
    }
  }

  async listSessions(): Promise<OpenCodeSession[]> {
    return [...this.sessions]
  }

  async listMessages(sessionId: string): Promise<OpenCodeMessage[]> {
    return [
      {
        info: { id: "msg_1", sessionID: sessionId, role: "assistant" },
        parts: [{ type: "text", text: "ready" }],
      },
    ]
  }

  async sendAsync(sessionId: string, input: SendMessageInput): Promise<void> {
    this.prompts.push({ sessionId, input })
  }

  async abortSession(_sessionId: string): Promise<boolean> {
    this.abortCount += 1
    return true
  }

  async listPendingPermissions(): Promise<OpenCodePermissionRequest[]> {
    return [...this.pendingPermissions]
  }

  async replyPermission(input: {
    sessionId: string
    requestId: string
    decision: OpenCodePermissionDecision
    message?: string
  }): Promise<void> {
    this.permissionReplies.push(input)
  }

  async subscribeEvents(_onEvent: (event: unknown) => void, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
  }
}

const config: ControlPlaneConfig = {
  host: "127.0.0.1",
  port: 0,
  opencodeBaseUrl: "http://opencode.test",
  opencodeDirectory: "/test/project",
  opencodeModel: { providerID: "test-provider", modelID: "test-model" },
  maxConcurrentWorkers: 2,
  maxRequestBytes: 100_000,
  databasePath: ":memory:",
}

async function inject(
  application: ReturnType<typeof createApplication>,
  method: string,
  path: string,
  body?: unknown,
): Promise<FakeResponse> {
  const request = new FakeRequest(method, path, body)
  const response = new FakeResponse()
  await application.handleRequest(request as unknown as IncomingMessage, response as unknown as ServerResponse)
  if (!response.writableFinished) await once(response, "finish")
  return response
}

test("OpenCodeAdapter probes routes and sends the exact legacy request shapes", async () => {
  const requests: Array<{ url: URL; init: RequestInit }> = []
  const encoder = new TextEncoder()
  const spec = {
    openapi: "3.1.0",
    paths: {
      "/session": { get: {}, post: {} },
      "/session/{sessionID}/message": { get: {} },
      "/session/{sessionID}/prompt_async": { post: {} },
      "/session/{sessionID}/abort": { post: {} },
      "/event": { get: {} },
      "/permission": { get: {} },
      "/permission/{requestID}/reply": { post: {} },
      "/api/session/{sessionID}/permission/{requestID}/reply": { post: {} },
    },
  }

  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    requests.push({ url, init })
    if (url.pathname === "/global/health") {
      return Response.json({ healthy: true, version: "1.17.15-test" })
    }
    if (url.pathname === "/doc") return Response.json(spec)
    if (url.pathname === "/session" && init.method === "POST") {
      return Response.json({ id: "ses_1", title: "main" })
    }
    if (url.pathname === "/session" && (init.method === undefined || init.method === "GET")) {
      return Response.json([{ id: "ses_1", title: "main" }])
    }
    if (url.pathname === "/session/ses_1/message") {
      return Response.json([{ info: { id: "msg_1" }, parts: [] }])
    }
    if (url.pathname === "/session/ses_1/prompt_async") return new Response(null, { status: 204 })
    if (url.pathname === "/session/ses_1/abort") return Response.json(true)
    if (url.pathname === "/permission") return Response.json([])
    if (url.pathname === "/permission/per_1/reply") return Response.json(true)
    if (url.pathname === "/event") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "server.connected" })}\n\n`))
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "session.status", properties: { sessionID: "ses_1" } })}\n\n`,
            ),
          )
          controller.close()
        },
      })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }
    return Response.json({ error: url.pathname }, { status: 404 })
  }

  const adapter = new OpenCodeAdapter({
    baseUrl: "http://opencode.test",
    directory: "/project with spaces",
    password: "secret",
    fetchImpl,
  })

  const capabilities = await adapter.probeCapabilities()
  assert.equal(capabilities.version, "1.17.15-test")
  assert.equal(capabilities.routes.v2PermissionReply, true)
  assert.equal(capabilities.routes.listSessions, true)
  assert.equal(capabilities.routes.permissionList, true)
  assert.equal(capabilities.routes.permissionReply, true)

  assert.equal((await adapter.createSession({ title: "main" })).id, "ses_1")
  assert.equal((await adapter.listSessions()).length, 1)
  assert.equal((await adapter.listMessages("ses_1")).length, 1)
  await adapter.sendAsync("ses_1", { text: "检查广告费" })
  assert.equal(await adapter.abortSession("ses_1"), true)
  assert.deepEqual(await adapter.listPendingPermissions(), [])
  await adapter.replyPermission({ sessionId: "ses_1", requestId: "per_1", decision: "once" })

  const events: unknown[] = []
  await adapter.subscribeEvents((event) => events.push(event), new AbortController().signal)
  assert.deepEqual(events, [
    { type: "server.connected" },
    { type: "session.status", properties: { sessionID: "ses_1" } },
  ])

  const scopedRequests = requests.filter((request) => !["/global/health", "/doc"].includes(request.url.pathname))
  assert.ok(scopedRequests.every((request) => request.url.searchParams.get("directory") === "/project with spaces"))

  const promptRequest = requests.find((request) => request.url.pathname.endsWith("/prompt_async"))
  assert.ok(promptRequest)
  assert.deepEqual(JSON.parse(String(promptRequest.init.body)), {
    parts: [{ type: "text", text: "检查广告费" }],
  })
  const promptHeaders = promptRequest.init.headers as Headers
  assert.match(promptHeaders.get("authorization") ?? "", /^Basic /)

  await adapter.createSession({
    title: "model override",
    model: { providerID: "ali", modelID: "qwen3-coder-plus" },
  })
  const createRequests = requests.filter((request) => request.url.pathname === "/session" && request.init.method === "POST")
  assert.deepEqual(JSON.parse(String(createRequests.at(-1)?.init.body)), {
    title: "model override",
    model: { providerID: "ali", id: "qwen3-coder-plus" },
  })
})

test("connection failures include the endpoint, root cause, and an actionable startup hint", async () => {
  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4096"), { code: "ECONNREFUSED" })
  const fetchImpl: typeof fetch = async () => {
    throw new TypeError("fetch failed", { cause })
  }
  const adapter = new OpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    directory: "/test/project",
    fetchImpl,
  })

  let failure: unknown
  try {
    await adapter.probeCapabilities()
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof OpenCodeConnectionError)
  assert.match(failure.message, /127\.0\.0\.1:4096\/global\/health|127\.0\.0\.1:4096\/doc/)
  assert.match(failure.message, /ECONNREFUSED/)

  const formatted = formatStartupError(failure, config)
  assert.match(formatted, /opencode serve --hostname 127\.0\.0\.1 --port 4096/)
  assert.match(formatted, /OPENCODE_BASE_URL/)
})

test("Control Plane creates main and dedicated approval sessions", async () => {
  const adapter = new FakeAdapter()
  const application = createApplication({ config, adapter: adapter as unknown as OpenCodeAdapter })

  const created = await inject(application, "POST", "/api/task-groups", { title: "商品损益排查" })
  assert.equal(created.statusCode, 201)
  const body = created.json as {
    taskGroup: { id: string; rootAgentId: string }
    agent: { id: string; opencodeSessionId: string }
    approver: { id: string; role: string; opencodeSessionId: string; parentAgentId: string }
  }
  assert.equal(body.agent.id, body.taskGroup.rootAgentId)
  assert.equal(body.agent.opencodeSessionId, "ses_1")
  assert.equal(adapter.sessions[0]?.title, "商品损益排查")
  assert.deepEqual(adapter.sessionInputs[0]?.permission?.[0], { permission: "*", pattern: "*", action: "ask" })
  assert.equal(body.approver.role, "APPROVER")
  assert.equal(body.approver.opencodeSessionId, "ses_2")
  assert.equal(body.approver.parentAgentId, body.agent.id)
  assert.equal(adapter.sessions[1]?.parentID, "ses_1")
  assert.deepEqual(adapter.sessionInputs[1]?.permission?.[0], { permission: "*", pattern: "*", action: "deny" })

  const details = await inject(application, "GET", `/api/task-groups/${body.taskGroup.id}`)
  assert.equal(details.statusCode, 200)
  const detailsBody = details.json as { agents: Array<{ id: string }> }
  assert.deepEqual(new Set(detailsBody.agents.map((agent) => agent.id)), new Set([body.agent.id, body.approver.id]))
})

test("root path presents a useful service page instead of a 404", async () => {
  const application = createApplication({ config, adapter: new FakeAdapter() as unknown as OpenCodeAdapter })
  const response = await inject(application, "GET", "/")
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8")
  assert.match(response.text, /Agent Teams/)
  assert.match(response.text, /创建 Agent Team/)
  assert.doesNotMatch(response.text, /批量创建 Worker/)
  assert.match(response.text, /\/api\/task-groups/)
  assert.match(response.text, /Worker 出现后/)
  assert.match(response.text, /最近任务/)
  assert.match(response.text, /SQLite/)
  assert.match(response.text, /工具调用/)
  assert.match(response.text, /setInterval\(refreshWorkspace,1500\)/)
  assert.match(response.text, />停止</)
  const script = response.text.match(/<script>([\s\S]+)<\/script>/)?.[1]
  assert.ok(script)
  assert.doesNotThrow(() => new Function(script))
})

test("project OpenCode model becomes the explicit Control Plane model", () => {
  const directory = mkdtempSync(join(tmpdir(), "control-plane-model-"))
  try {
    writeFileSync(join(directory, "opencode.json"), JSON.stringify({ model: "ali/qwen3-coder-plus" }))
    const loaded = loadConfig({ OPENCODE_DIRECTORY: directory })
    assert.deepEqual(loaded.opencodeModel, { providerID: "ali", modelID: "qwen3-coder-plus" })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Control Plane sends prompts, returns history, and aborts a main agent", async () => {
  const adapter = new FakeAdapter()
  const application = createApplication({ config, adapter: adapter as unknown as OpenCodeAdapter })
  const created = await inject(application, "POST", "/api/task-groups", { title: "商品损益排查" })
  const { agent } = created.json as { agent: { id: string } }

  const prompt = await inject(application, "POST", `/api/agents/${agent.id}/messages`, { text: "检查广告费" })
  assert.equal(prompt.statusCode, 202)
  assert.equal((prompt.json as { accepted: boolean }).accepted, true)
  assert.equal(adapter.prompts[0]?.sessionId, "ses_1")
  assert.equal(adapter.prompts[0]?.input.text, "检查广告费")
  assert.deepEqual(adapter.prompts[0]?.input.model, { providerID: "test-provider", modelID: "test-model" })
  assert.match(adapter.prompts[0]?.input.system ?? "", /spawn_workers/)
  assert.equal(adapter.prompts[0]?.input.tools?.answer_worker, true)

  const history = await inject(application, "GET", `/api/agents/${agent.id}/messages`)
  assert.equal(history.statusCode, 200)
  assert.equal((history.json as { items: unknown[] }).items.length, 1)

  const abort = await inject(application, "POST", `/api/agents/${agent.id}/abort`)
  assert.equal(abort.statusCode, 200)
  assert.deepEqual(abort.json, { aborted: true })
  assert.equal(adapter.abortCount, 1)
})

test("message history exposes model failures and the current Agent state", async () => {
  class ErrorAdapter extends FakeAdapter {
    override async listMessages(sessionId: string): Promise<OpenCodeMessage[]> {
      return [{
        info: {
          id: "msg_error",
          sessionID: sessionId,
          role: "assistant",
          error: { data: { message: "模型凭证无效" } },
          tokens: { output: 0 },
        },
        parts: [],
      }]
    }
  }
  const adapter = new ErrorAdapter()
  const application = createApplication({ config, adapter: adapter as unknown as OpenCodeAdapter })
  const created = await inject(application, "POST", "/api/task-groups", { title: "错误反馈测试" })
  const { agent } = created.json as { agent: { id: string } }
  const history = await inject(application, "GET", `/api/agents/${agent.id}/messages`)
  const body = history.json as { warning?: string; agent?: { id: string } }
  assert.match(body.warning ?? "", /模型凭证无效/)
  assert.equal(body.agent?.id, agent.id)
})

test("spawns independent child sessions in a batch and deduplicates retries", async () => {
  const adapter = new FakeAdapter()
  const application = createApplication({ config, adapter: adapter as unknown as OpenCodeAdapter })
  const created = await inject(application, "POST", "/api/task-groups", { title: "商品损益排查" })
  const { taskGroup, agent: mainAgent } = created.json as {
    taskGroup: { id: string }
    agent: { id: string; opencodeSessionId: string }
  }
  const batch = {
    request_id: "batch-001",
    tasks: [
      { field_key: "ads", title: "广告费", prompt: "检查广告费" },
      { field_key: "shipping", title: "履约费", prompt: "检查履约费" },
    ],
  }

  const first = await inject(application, "POST", `/api/task-groups/${taskGroup.id}/workers`, batch)
  assert.equal(first.statusCode, 201)
  const firstBody = first.json as {
    idempotent: boolean
    tasks: Array<{ status: string; workerAgentId: string }>
    agents: Array<{ role: string; parentAgentId: string; opencodeSessionId: string }>
  }
  assert.equal(firstBody.idempotent, false)
  assert.deepEqual(firstBody.tasks.map((task) => task.status), ["RUNNING", "RUNNING"])
  assert.equal(firstBody.agents.length, 2)
  assert.ok(firstBody.agents.every((worker) => worker.role === "WORKER"))
  assert.ok(firstBody.agents.every((worker) => worker.parentAgentId === mainAgent.id))
  assert.deepEqual(adapter.sessions.slice(2).map((session) => session.parentID), ["ses_1", "ses_1"])
  assert.ok(adapter.sessionInputs.slice(2).every((input) => input.permission?.[0]?.action === "ask"))
  assert.deepEqual(adapter.prompts.map((prompt) => prompt.input.text), ["检查广告费", "检查履约费"])
  assert.ok(adapter.prompts.every((prompt) => prompt.input.tools?.question === false))
  assert.ok(adapter.prompts.every((prompt) => prompt.input.tools?.ask_main_agent === true))

  const repeated = await inject(application, "POST", `/api/task-groups/${taskGroup.id}/workers`, batch)
  assert.equal(repeated.statusCode, 200)
  assert.equal((repeated.json as { idempotent: boolean }).idempotent, true)
  assert.equal(adapter.sessions.length, 4)

  const group = await inject(application, "GET", `/api/task-groups/${taskGroup.id}`)
  const groupBody = group.json as { agents: unknown[]; workerTasks: unknown[] }
  assert.equal(groupBody.agents.length, 4)
  assert.equal(groupBody.workerTasks.length, 2)
})

test("worker creation respects the configured concurrency limit", async () => {
  const adapter = new FakeAdapter(5)
  const application = createApplication({ config, adapter: adapter as unknown as OpenCodeAdapter })
  const created = await inject(application, "POST", "/api/task-groups", { title: "并发测试" })
  const { taskGroup } = created.json as { taskGroup: { id: string } }
  adapter.resetCreateMetrics()

  const response = await inject(application, "POST", `/api/task-groups/${taskGroup.id}/workers`, {
    request_id: "concurrency-batch",
    tasks: Array.from({ length: 5 }, (_, index) => ({
      field_key: `field-${index}`,
      title: `字段 ${index}`,
      prompt: `检查字段 ${index}`,
    })),
  })
  assert.equal(response.statusCode, 201)
  assert.equal(adapter.maxActiveCreates, 2)
})

test("Permission Manager auto-allows read-only work and rejects destructive commands", async () => {
  const adapter = new FakeAdapter()
  const application = createApplication({ config, adapter: adapter as unknown as OpenCodeAdapter })
  const created = await inject(application, "POST", "/api/task-groups", { title: "权限策略测试" })
  const { taskGroup } = created.json as { taskGroup: { id: string } }
  const workers = await inject(application, "POST", `/api/task-groups/${taskGroup.id}/workers`, {
    request_id: "permission-policy",
    tasks: [{ field_key: "ads", title: "广告费", prompt: "检查广告费" }],
  })
  const worker = (workers.json as { agents: Array<{ id: string; opencodeSessionId: string }> }).agents[0]

  const read = await application.permissionManager.ingest({
    id: "per_read",
    sessionID: worker.opencodeSessionId,
    permission: "read",
    patterns: ["src/report.ts"],
  })
  assert.equal(read?.status, "APPROVED")
  assert.equal(read?.decisionSource, "STATIC_POLICY")
  assert.equal(adapter.permissionReplies[0]?.decision, "once")

  const safeBash = await application.permissionManager.ingest({
    id: "per_pwd",
    sessionID: worker.opencodeSessionId,
    permission: "bash",
    metadata: { command: "pwd" },
  })
  assert.equal(safeBash?.status, "APPROVED")
  assert.equal(safeBash?.risk, "LOW")
  assert.equal(adapter.permissionReplies[1]?.decision, "once")

  const destructive = await application.permissionManager.ingest({
    id: "per_delete",
    sessionID: worker.opencodeSessionId,
    permission: "bash",
    metadata: { command: "rm -rf ./reports" },
  })
  assert.equal(destructive?.status, "REJECTED")
  assert.equal(destructive?.risk, "CRITICAL")
  assert.equal(adapter.permissionReplies[2]?.decision, "reject")

  const audit = await inject(application, "GET", "/api/audit")
  assert.equal(audit.statusCode, 200)
  assert.ok((audit.json as { items: unknown[] }).items.length >= 4)
})

test("ambiguous permissions route directly to the dedicated approval Agent", async () => {
  const adapter = new FakeAdapter()
  const application = createApplication({ config, adapter: adapter as unknown as OpenCodeAdapter })
  const created = await inject(application, "POST", "/api/task-groups", { title: "审批路由测试" })
  const { taskGroup, agent: main, approver } = created.json as {
    taskGroup: { id: string }
    agent: { opencodeSessionId: string }
    approver: { opencodeSessionId: string }
  }
  const workers = await inject(application, "POST", `/api/task-groups/${taskGroup.id}/workers`, {
    request_id: "permission-routing",
    tasks: [{ field_key: "shipping", title: "履约费", prompt: "检查履约费" }],
  })
  const worker = (workers.json as { agents: Array<{ opencodeSessionId: string }> }).agents[0]

  await application.permissionManager.handleOpenCodeEvent({
    type: "permission.v2.asked",
    properties: {
      id: "per_unknown",
      sessionID: worker.opencodeSessionId,
      action: "finance_query",
      resources: ["shipping_cost"],
      metadata: { mode: "read" },
    },
  })
  const pendingResponse = await inject(
    application,
    "GET",
    `/api/permissions?status=PENDING&task_group_id=${taskGroup.id}`,
  )
  const pending = (pendingResponse.json as { items: Array<{ id: string; reviewRequested: boolean }> }).items[0]
  assert.equal(pending.reviewRequested, true)
  assert.equal(adapter.prompts.some((prompt) => prompt.sessionId === main.opencodeSessionId && /review_permission/.test(prompt.input.system ?? "")), false)
  assert.ok(adapter.prompts.some((prompt) => prompt.sessionId === approver.opencodeSessionId && /review_permission/.test(prompt.input.system ?? "")))

  const recommendation = await inject(application, "POST", "/internal/orchestrator/permission-reviews", {
    caller_session_id: approver.opencodeSessionId,
    permission_id: pending.id,
    review: "approve_once",
    reason: "只读财务查询",
  })
  assert.equal(recommendation.statusCode, 200)
  assert.equal((recommendation.json as { decisionSource: string }).decisionSource, "APPROVAL_AGENT")
  assert.equal(adapter.permissionReplies.at(-1)?.decision, "once")

  const highRisk = await application.permissionManager.ingest({
    id: "per_bash",
    sessionID: worker.opencodeSessionId,
    permission: "bash",
    patterns: ["python scripts/query.py --field shipping"],
  })
  assert.equal(highRisk?.status, "PENDING")
  assert.equal(highRisk?.risk, "HIGH")
  assert.ok(adapter.prompts.some((prompt) => prompt.sessionId === approver.opencodeSessionId && /python scripts\/query\.py/.test(prompt.input.text)))
  const escalated = await inject(application, "POST", "/internal/orchestrator/permission-reviews", {
    caller_session_id: approver.opencodeSessionId,
    permission_id: highRisk?.id,
    review: "escalate",
    reason: "无法确认脚本是否只读",
  })
  assert.equal((escalated.json as { status: string }).status, "PENDING")
  const human = await inject(application, "POST", `/api/permissions/${highRisk?.id}/decision`, {
    decision: "always",
  })
  assert.equal(human.statusCode, 200)
  assert.equal((human.json as { decisionSource: string }).decisionSource, "HUMAN")
  assert.equal(adapter.permissionReplies.at(-1)?.decision, "always")
})

test("workers ask the main Agent and receive an answer in their own session", async () => {
  const adapter = new FakeAdapter()
  const application = createApplication({ config, adapter: adapter as unknown as OpenCodeAdapter })
  const created = await inject(application, "POST", "/api/task-groups", { title: "监工通信测试" })
  const { taskGroup, agent: main } = created.json as {
    taskGroup: { id: string }
    agent: { opencodeSessionId: string }
  }
  const workers = await inject(application, "POST", `/api/task-groups/${taskGroup.id}/workers`, {
    request_id: "question-routing",
    tasks: [{ field_key: "ads", title: "广告费", prompt: "检查广告费" }],
  })
  const worker = (workers.json as { agents: Array<{ id: string; opencodeSessionId: string }> }).agents[0]

  const asked = await inject(application, "POST", "/internal/orchestrator/ask-main", {
    caller_session_id: worker.opencodeSessionId,
    question: "两个口径不一致时以哪个为准？",
    context: "A 文档写含税，B SQL 未含税。",
  })
  assert.equal(asked.statusCode, 201)
  const question = asked.json as { id: string; status: string }
  assert.equal(question.status, "OPEN")
  assert.ok(adapter.prompts.some((prompt) => prompt.sessionId === main.opencodeSessionId && prompt.input.text.includes(question.id)))

  const answered = await inject(application, "POST", "/internal/orchestrator/answer-worker", {
    caller_session_id: main.opencodeSessionId,
    question_id: question.id,
    answer: "统一按含税口径，并在结论中说明换算。",
  })
  assert.equal(answered.statusCode, 200)
  assert.equal((answered.json as { status: string }).status, "ANSWERED")
  assert.ok(adapter.prompts.some((prompt) => prompt.sessionId === worker.opencodeSessionId && /统一按含税口径/.test(prompt.input.text)))

  const listed = await inject(application, "POST", "/internal/orchestrator/list-workers", {
    caller_session_id: main.opencodeSessionId,
  })
  assert.equal((listed.json as { items: unknown[] }).items.length, 1)
  const messaged = await inject(application, "POST", "/internal/orchestrator/message-worker", {
    caller_session_id: main.opencodeSessionId,
    worker_agent_id: worker.id,
    message: "再补充最近七天的样本。",
  })
  assert.equal(messaged.statusCode, 202)
  assert.ok(adapter.prompts.some((prompt) => prompt.sessionId === worker.opencodeSessionId && /最近七天/.test(prompt.input.text)))
})

test("SQLite store persists task groups, workers, permissions, audit, and idempotency keys", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-control-plane-store-"))
  const databasePath = join(directory, "control-plane.sqlite")
  const first = new SqliteStore(databasePath)
  let second: SqliteStore | undefined
  t.after(() => {
    first.close()
    second?.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const created = first.createTaskGroup({ title: "持久化测试", sessionId: "ses_persisted_main" })
  const reserved = first.reserveWorkerTasks({
    taskGroupId: created.taskGroup.id,
    requestId: "persistent-batch",
    tasks: [{ fieldKey: "ads", title: "广告费", prompt: "检查广告费" }],
  })
  const worker = first.attachWorker({
    taskId: reserved.tasks[0].id,
    parentAgentId: created.agent.id,
    sessionId: "ses_persisted_worker",
  }).agent
  first.upsertPermissionRequest({
    agent: worker,
    opencodeRequestId: "per_persisted",
    action: "bash",
    resources: ["query.py"],
    metadata: { mode: "read" },
    risk: "HIGH",
  })
  first.appendAudit({
    type: "test.persisted",
    taskGroupId: created.taskGroup.id,
    agentId: worker.id,
    data: { ok: true },
  })
  const question = first.createAgentQuestion({
    worker,
    main: created.agent,
    question: "持久化的问题",
  })
  first.close()

  second = new SqliteStore(databasePath)
  const restored = second.getTaskGroup(created.taskGroup.id)
  assert.equal(restored?.taskGroup.title, "持久化测试")
  assert.equal(restored?.agents.length, 2)
  assert.equal(second.listPermissionRequests({ status: "PENDING" }).length, 1)
  assert.equal(second.listAuditRecords().some((record) => record.type === "test.persisted"), true)
  assert.equal(second.getAgentQuestion(question.id)?.question, "持久化的问题")
  const repeated = second.reserveWorkerTasks({
    taskGroupId: created.taskGroup.id,
    requestId: "persistent-batch",
    tasks: [{ fieldKey: "ignored", title: "不会重复", prompt: "不会重复" }],
  })
  assert.equal(repeated.created, false)
  assert.equal(repeated.tasks[0]?.id, reserved.tasks[0].id)
})

test("application startup restores active sessions and marks missing sessions as failed", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-control-plane-recovery-"))
  const databasePath = join(directory, "control-plane.sqlite")
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const seed = new SqliteStore(databasePath)
  const created = seed.createTaskGroup({ title: "恢复测试", sessionId: "ses_recovery_main" })
  seed.setAgentStatus(created.agent.id, "RUNNING")
  seed.close()

  const recoveryConfig = { ...config, databasePath }
  const adapter = new FakeAdapter()
  adapter.sessions.push({ id: "ses_recovery_main", title: "恢复测试" })
  const activeApplication = createApplication({
    config: recoveryConfig,
    adapter: adapter as unknown as OpenCodeAdapter,
  })
  await activeApplication.initialize()
  const active = await inject(activeApplication, "GET", `/api/task-groups/${created.taskGroup.id}`)
  assert.equal((active.json as { agents: Array<{ lifecycleStatus: string }> }).agents[0]?.lifecycleStatus, "READY")
  const history = await inject(activeApplication, "GET", "/api/task-groups")
  assert.equal((history.json as { items: unknown[] }).items.length, 1)
  await activeApplication.stop()

  adapter.sessions.splice(0)
  const missingApplication = createApplication({
    config: recoveryConfig,
    adapter: adapter as unknown as OpenCodeAdapter,
  })
  await missingApplication.initialize()
  const missing = await inject(missingApplication, "GET", `/api/task-groups/${created.taskGroup.id}`)
  const missingBody = missing.json as {
    taskGroup: { status: string }
    agents: Array<{ lifecycleStatus: string; lastError?: string }>
  }
  assert.equal(missingBody.taskGroup.status, "FAILED")
  assert.equal(missingBody.agents[0]?.lifecycleStatus, "FAILED")
  assert.match(missingBody.agents[0]?.lastError ?? "", /not found/i)
  await missingApplication.stop()
})

test("Control Plane validates input and reports missing resources", async () => {
  const application = createApplication({ config, adapter: new FakeAdapter() as unknown as OpenCodeAdapter })
  const invalid = await inject(application, "POST", "/api/task-groups", { title: "" })
  assert.equal(invalid.statusCode, 400)
  assert.equal((invalid.json as { error: { code: string } }).error.code, "INVALID_TITLE")

  const missing = await inject(application, "GET", "/api/agents/not-found/messages")
  assert.equal(missing.statusCode, 404)
  assert.equal((missing.json as { error: { code: string } }).error.code, "AGENT_NOT_FOUND")
})

test("EventHub forwards normalized SSE without exposing OpenCode directly", async () => {
  const hub = new EventHub()
  const response = new FakeResponse()
  hub.addClient(response as unknown as ServerResponse)
  hub.publish("opencode.event", { type: "session.status", properties: { sessionID: "ses_1" } })
  hub.close()
  if (!response.writableFinished) await once(response, "finish")

  assert.match(response.text, /event: control_plane\.connected/)
  assert.match(response.text, /event: opencode\.event/)
  assert.match(response.text, /session\.status/)
})
