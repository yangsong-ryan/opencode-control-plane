import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
  type OpenCodeAgentInfo,
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
  deletedSessions: string[] = []
  activeCreates = 0
  maxActiveCreates = 0
  private nextSession = 1
  private readonly createDelayMs: number
  readonly agents: OpenCodeAgentInfo[] = [
    { name: "build", description: "Default build Agent", mode: "primary", native: true },
    { name: "control-plane-main", description: "Control Plane main Agent", mode: "primary", hidden: true, native: false },
    { name: "permission-approver", description: "Permission approver", mode: "primary", hidden: true, native: false },
    { name: "control-plane-worker", description: "Generic Control Plane Worker", mode: "primary", native: false },
    { name: "sql-investigator", description: "Investigate SQL data", mode: "subagent", native: false },
  ]

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
        listAgents: true,
        createSession: true,
        deleteSession: true,
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

  async deleteSession(sessionId: string): Promise<boolean> {
    this.deletedSessions.push(sessionId)
    const index = this.sessions.findIndex((session) => session.id === sessionId)
    if (index !== -1) this.sessions.splice(index, 1)
    return true
  }

  async listAgents(): Promise<OpenCodeAgentInfo[]> {
    return [...this.agents]
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
  mainAgentName: "control-plane-main",
  approvalAgentName: "permission-approver",
  defaultWorkerAgentName: "control-plane-worker",
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
      "/agent": { get: {} },
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
    if (url.pathname === "/agent") {
      return Response.json([{ name: "build", description: "Default build Agent", mode: "primary", native: true }])
    }
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
  assert.equal(capabilities.routes.listAgents, true)
  assert.equal(capabilities.routes.v2PermissionReply, true)
  assert.equal(capabilities.routes.listSessions, true)
  assert.equal(capabilities.routes.permissionList, true)
  assert.equal(capabilities.routes.permissionReply, true)

  assert.equal((await adapter.createSession({ title: "main" })).id, "ses_1")
  assert.equal((await adapter.listSessions()).length, 1)
  assert.equal((await adapter.listAgents())[0]?.name, "build")
  assert.equal((await adapter.listMessages("ses_1")).length, 1)
  await adapter.sendAsync("ses_1", {
    text: "检查广告费",
    agent: "control-plane-main",
    model: { providerID: "ali", modelID: "qwen3-coder-plus" },
    system: "DYNAMIC_MAIN_SYSTEM_PROMPT",
  })
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
  const promptBody = JSON.parse(String(promptRequest.init.body)) as Record<string, unknown>
  assert.deepEqual(promptBody, {
    agent: "control-plane-main",
    model: { providerID: "ali", modelID: "qwen3-coder-plus" },
    system: "DYNAMIC_MAIN_SYSTEM_PROMPT",
    parts: [{ type: "text", text: "检查广告费" }],
  })
  assert.equal(Object.hasOwn(promptBody, "tools"), false)
  assert.equal(Object.hasOwn(promptBody, "permission"), false)
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

test("Control Plane creates one main session and a logical approval timeline", async () => {
  const adapter = new FakeAdapter()
  const application = createApplication({ config, adapter: adapter as unknown as OpenCodeAdapter })

  const created = await inject(application, "POST", "/api/task-groups", { title: "商品损益排查" })
  assert.equal(created.statusCode, 201)
  const body = created.json as {
    taskGroup: { id: string; rootAgentId: string; approvalPolicy: string }
    agent: { id: string; opencodeSessionId: string; opencodeAgentName: string }
    approver: { id: string; role: string; opencodeSessionId: string; parentAgentId: string; opencodeAgentName: string }
  }
  assert.equal(body.agent.id, body.taskGroup.rootAgentId)
  assert.match(body.taskGroup.approvalPolicy, /永远不能授予持久权限/)
  assert.equal(body.agent.opencodeSessionId, "ses_1")
  assert.equal(body.agent.opencodeAgentName, "control-plane-main")
  assert.equal(adapter.sessions[0]?.title, "商品损益排查")
  assert.equal(adapter.sessionInputs[0]?.permission, undefined)
  assert.equal(body.approver.role, "APPROVER")
  assert.equal(body.approver.opencodeSessionId, "logical-approver:" + body.taskGroup.id)
  assert.equal(body.approver.parentAgentId, body.agent.id)
  assert.equal(body.approver.opencodeAgentName, "permission-approver")
  assert.equal(adapter.sessions.length, 1)

  const details = await inject(application, "GET", `/api/task-groups/${body.taskGroup.id}`)
  assert.equal(details.statusCode, 200)
  const detailsBody = details.json as { agents: Array<{ id: string }> }
  assert.deepEqual(new Set(detailsBody.agents.map((agent) => agent.id)), new Set([body.agent.id, body.approver.id]))
})

test("team titles are required, editable, and deletable with their OpenCode sessions", async () => {
  const adapter = new FakeAdapter()
  const application = createApplication({ config, adapter: adapter as unknown as OpenCodeAdapter })

  const blank = await inject(application, "POST", "/api/task-groups", { title: "   " })
  assert.equal(blank.statusCode, 400)

  const created = await inject(application, "POST", "/api/task-groups", { title: "临时团队" })
  const body = created.json as {
    taskGroup: { id: string }
    agent: { opencodeSessionId: string }
  }
  const renamed = await inject(application, "PATCH", "/api/task-groups/" + body.taskGroup.id, {
    title: "长期任务团队",
  })
  assert.equal(renamed.statusCode, 200)
  assert.equal((renamed.json as { taskGroup: { title: string } }).taskGroup.title, "长期任务团队")
  const blankRename = await inject(application, "PATCH", "/api/task-groups/" + body.taskGroup.id, {
    title: "\n",
  })
  assert.equal(blankRename.statusCode, 400)

  const deleted = await inject(application, "DELETE", "/api/task-groups/" + body.taskGroup.id)
  assert.equal(deleted.statusCode, 200)
  assert.deepEqual(adapter.deletedSessions, [body.agent.opencodeSessionId])
  const missing = await inject(application, "GET", "/api/task-groups/" + body.taskGroup.id)
  assert.equal(missing.statusCode, 404)
})

test("root path presents a useful service page instead of a 404", async () => {
  const application = createApplication({ config, adapter: new FakeAdapter() as unknown as OpenCodeAdapter })
  const response = await inject(application, "GET", "/")
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8")
  assert.match(response.text, /Agent Teams/)
  assert.match(response.text, /创建 Agent Team/)
  assert.match(response.text, /placeholder="输入团队名称"/)
  assert.doesNotMatch(response.text, /value="商品损益排查"/)
  assert.match(response.text, /id="rename-team"/)
  assert.match(response.text, /id="delete-team"/)
  assert.doesNotMatch(response.text, /批量创建 Worker/)
  assert.match(response.text, /\/api\/task-groups/)
  assert.match(response.text, /Worker 出现后/)
  assert.match(response.text, /最近任务/)
  assert.match(response.text, /SQLite/)
  assert.match(response.text, /工具调用/)
  assert.match(response.text, /setInterval\(refreshWorkspace,1500\)/)
  assert.match(response.text, />停止本轮</)
  assert.match(response.text, /权限记录/)
  assert.match(response.text, /renderMarkdown/)
  assert.match(response.text, /chatFollow/)
  assert.match(response.text, /distance<=24/)
  assert.match(response.text, /isActivelyWaiting/)
  assert.match(response.text, /return null/)
  assert.match(response.text, /权限审批 Agent/)
  assert.match(response.text, /Agent 审批中/)
  assert.match(response.text, /审批 Agent 已升级为人工审批/)
  assert.match(response.text, /升级人工原因/)
  assert.match(response.text, /Enter 发送 · Shift \+ Enter 换行/)
  assert.match(response.text, /event\.isComposing/)
  assert.match(response.text, /selectionInside/)
  assert.match(response.text, /agentSignature/)
  assert.match(response.text, /messageLoadToken/)
  assert.match(response.text, /background:#ffd166/)
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

test("default deployment separates backend state from the bundled team workspace", () => {
  const loaded = loadConfig({})
  assert.equal(loaded.opencodeDirectory, join(process.cwd(), "workspace-template"))
  assert.equal(loaded.databasePath, join(process.cwd(), ".data", "opencode-control-plane.sqlite"))
})

test("project OpenCode config owns Agent tool visibility and permissions", () => {
  const projectConfig = JSON.parse(readFileSync(join(process.cwd(), "workspace-template", "opencode.json"), "utf8")) as {
    agent: Record<string, { prompt?: string; tools?: Record<string, boolean>; permission: Record<string, unknown> }>
  }
  const main = projectConfig.agent["control-plane-main"]
  const approver = projectConfig.agent["permission-approver"]
  const worker = projectConfig.agent["control-plane-worker"]
  assert.match(main?.prompt ?? "", /NATIVE_MAIN_PROMPT_V2/)
  assert.match(approver?.prompt ?? "", /NATIVE_APPROVER_PROMPT_V2/)
  assert.match(worker?.prompt ?? "", /NATIVE_WORKER_PROMPT_V1/)
  assert.equal(main?.permission.spawn_workers, "allow")
  assert.equal(main?.permission.set_approval_policy, "allow")
  assert.equal(main?.permission.read, "allow")
  assert.equal(main?.tools?.task, false)
  assert.equal(main?.permission.task, "deny")
  assert.equal(approver?.permission["*"], "deny")
  assert.equal(approver?.permission.review_permission, "allow")
  assert.equal(worker?.permission.question, "deny")
  assert.equal(worker?.permission.ask_main_agent, "allow")
  assert.equal(worker?.tools?.task, false)
  assert.equal(worker?.permission.task, "deny")
  assert.equal(worker?.permission.set_approval_policy, "deny")
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
  assert.equal(adapter.prompts[0]?.input.agent, "control-plane-main")
  assert.deepEqual(adapter.prompts[0]?.input.model, { providerID: "test-provider", modelID: "test-model" })
  assert.match(adapter.prompts[0]?.input.system ?? "", /spawn_workers/)
  assert.equal(Object.hasOwn(adapter.prompts[0]?.input ?? {}, "tools"), false)

  const history = await inject(application, "GET", `/api/agents/${agent.id}/messages`)
  assert.equal(history.statusCode, 200)
  assert.equal((history.json as { items: unknown[] }).items.length, 1)

  const abort = await inject(application, "POST", `/api/agents/${agent.id}/abort`)
  assert.equal(abort.statusCode, 200)
  assert.deepEqual(abort.json, { aborted: true })
  assert.equal(adapter.abortCount, 1)
  const groupAfterAbort = await inject(application, "GET", "/api/task-groups")
  const abortedAgent = (groupAfterAbort.json as {
    items: Array<{ agents: Array<{ id: string; lifecycleStatus: string }> }>
  }).items[0]?.agents.find((item) => item.id === agent.id)
  assert.equal(abortedAgent?.lifecycleStatus, "IDLE")
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

test("a trailing empty assistant envelope does not hide a valid model reply", async () => {
  class TrailingEnvelopeAdapter extends FakeAdapter {
    override async listMessages(sessionId: string): Promise<OpenCodeMessage[]> {
      return [
        { info: { id: "msg_user", sessionID: sessionId, role: "user" }, parts: [{ type: "text", text: "检查" }] },
        { info: { id: "msg_answer", sessionID: sessionId, role: "assistant" }, parts: [{ type: "text", text: "检查完成" }] },
        { info: { id: "msg_envelope", sessionID: sessionId, role: "assistant", tokens: { output: 0 } }, parts: [] },
      ]
    }
  }
  const application = createApplication({ config, adapter: new TrailingEnvelopeAdapter() as unknown as OpenCodeAdapter })
  const created = await inject(application, "POST", "/api/task-groups", { title: "空消息误报测试" })
  const { agent } = created.json as { agent: { id: string } }
  const history = await inject(application, "GET", `/api/agents/${agent.id}/messages`)
  assert.equal((history.json as { warning?: string }).warning, undefined)
})

test("an unfinished streaming assistant envelope does not produce a false empty-model warning", async () => {
  class StreamingEnvelopeAdapter extends FakeAdapter {
    override async listMessages(sessionId: string): Promise<OpenCodeMessage[]> {
      return [
        { info: { id: "msg_user", sessionID: sessionId, role: "user" }, parts: [{ type: "text", text: "检查" }] },
        { info: { id: "msg_streaming", sessionID: sessionId, role: "assistant", tokens: { output: 0 } }, parts: [] },
      ]
    }
  }
  const application = createApplication({ config, adapter: new StreamingEnvelopeAdapter() as unknown as OpenCodeAdapter })
  const created = await inject(application, "POST", "/api/task-groups", { title: "流式空消息测试" })
  const { agent } = created.json as { agent: { id: string } }
  const history = await inject(application, "GET", `/api/agents/${agent.id}/messages`)
  assert.equal((history.json as { warning?: string }).warning, undefined)
})

test("a completed zero-token assistant response still reports the real model problem", async () => {
  class CompletedEmptyAdapter extends FakeAdapter {
    override async listMessages(sessionId: string): Promise<OpenCodeMessage[]> {
      return [
        { info: { id: "msg_user", sessionID: sessionId, role: "user" }, parts: [{ type: "text", text: "检查" }] },
        {
          info: {
            id: "msg_empty",
            sessionID: sessionId,
            role: "assistant",
            time: { completed: Date.now() },
            finish: "stop",
            tokens: { output: 0 },
          },
          parts: [],
        },
      ]
    }
  }
  const application = createApplication({ config, adapter: new CompletedEmptyAdapter() as unknown as OpenCodeAdapter })
  const created = await inject(application, "POST", "/api/task-groups", { title: "真实空响应测试" })
  const { agent } = created.json as { agent: { id: string } }
  const history = await inject(application, "GET", `/api/agents/${agent.id}/messages`)
  assert.match((history.json as { warning?: string }).warning ?? "", /零 token|空内容/)
})

test("a recovered Agent with a missing OpenCode Session cannot enter a fake running state", async () => {
  const adapter = new FakeAdapter()
  const application = createApplication({ config, adapter: adapter as unknown as OpenCodeAdapter })
  const created = await inject(application, "POST", "/api/task-groups", { title: "失效 Session 测试" })
  const { agent } = created.json as { agent: { id: string } }
  application.store.setAgentStatus(
    agent.id,
    "FAILED",
    "OpenCode Session was not found during startup recovery.",
  )

  const history = await inject(application, "GET", "/api/agents/" + agent.id + "/messages")
  assert.equal(history.statusCode, 200)
  assert.match((history.json as { warning?: string }).warning ?? "", /Session 已失效/)

  const sent = await inject(application, "POST", "/api/agents/" + agent.id + "/messages", { text: "你好" })
  assert.equal(sent.statusCode, 409)
  assert.equal((sent.json as { error: { code: string } }).error.code, "AGENT_SESSION_UNAVAILABLE")
  assert.equal(application.store.getAgent(agent.id)?.lifecycleStatus, "FAILED")
  assert.equal(adapter.prompts.length, 0)
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
      { agent_name: "sql-investigator", field_key: "ads", title: "广告费", prompt: "检查广告费" },
      { agent_name: "build", field_key: "shipping", title: "履约费", prompt: "检查履约费" },
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
  assert.deepEqual(adapter.sessions.slice(1).map((session) => session.parentID), ["ses_1", "ses_1"])
  assert.ok(adapter.sessionInputs.slice(1).every((input) => input.permission === undefined))
  assert.deepEqual(adapter.prompts.map((prompt) => prompt.input.agent), ["sql-investigator", "build"])
  assert.deepEqual(adapter.prompts.map((prompt) => prompt.input.text), ["检查广告费", "检查履约费"])
  assert.ok(adapter.prompts.every((prompt) => !Object.hasOwn(prompt.input, "tools")))
  assert.ok(adapter.prompts.every((prompt) => /ask_main_agent/.test(prompt.input.system ?? "")))

  const repeated = await inject(application, "POST", `/api/task-groups/${taskGroup.id}/workers`, batch)
  assert.equal(repeated.statusCode, 200)
  assert.equal((repeated.json as { idempotent: boolean }).idempotent, true)
  assert.equal(adapter.sessions.length, 3)

  const group = await inject(application, "GET", `/api/task-groups/${taskGroup.id}`)
  const groupBody = group.json as { agents: unknown[]; workerTasks: unknown[] }
  assert.equal(groupBody.agents.length, 4)
  assert.equal(groupBody.workerTasks.length, 2)

  const encodedTasks = await inject(application, "POST", `/api/task-groups/${taskGroup.id}/workers`, {
    request_id: "stringified-tasks",
    tasks: JSON.stringify([
      { agent_name: "control-plane-worker", field_key: "worker_a", title: "Worker A", prompt: "检查 README" },
    ]),
  })
  assert.equal(encodedTasks.statusCode, 400)
  assert.equal((encodedTasks.json as { error: { code: string } }).error.code, "INVALID_TASKS_ARRAY_REQUIRED")
  assert.match((encodedTasks.json as { error: { message: string } }).error.message, /actual JSON array/)

  const unknownType = await inject(application, "POST", `/api/task-groups/${taskGroup.id}/workers`, {
    request_id: "unknown-agent-type",
    tasks: [{ agent_name: "missing-agent", field_key: "missing", title: "不存在", prompt: "不会执行" }],
  })
  assert.equal(unknownType.statusCode, 404)
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
  const pending = (pendingResponse.json as { items: Array<{ id: string; reviewRequested: boolean; approvalSessionId: string }> }).items[0]
  assert.equal(pending.reviewRequested, true)
  assert.equal(adapter.prompts.some((prompt) => prompt.sessionId === main.opencodeSessionId && /review_permission/.test(prompt.input.system ?? "")), false)
  assert.notEqual(pending.approvalSessionId, approver.opencodeSessionId)
  const approvalPrompt = adapter.prompts.find((prompt) => prompt.sessionId === pending.approvalSessionId && /review_permission/.test(prompt.input.system ?? ""))
  assert.ok(approvalPrompt)
  assert.equal(approvalPrompt.input.agent, "permission-approver")
  assert.equal(Object.hasOwn(approvalPrompt.input, "tools"), false)
  assert.match(approvalPrompt.input.text, /有一条 Agent 权限请求等待审核/)
  assert.match(approvalPrompt.input.text, /Worker 分配任务：履约费/)
  assert.match(approvalPrompt.input.text, /配置的工作空间/)
  assert.match(approvalPrompt.input.system ?? "", /必须且只能调用一次 review_permission/)

  const recommendation = await inject(application, "POST", "/internal/orchestrator/permission-reviews", {
    caller_session_id: pending.approvalSessionId,
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
  assert.ok(adapter.prompts.some((prompt) => prompt.sessionId === highRisk?.approvalSessionId && /python scripts\/query\.py/.test(prompt.input.text)))
  const escalated = await inject(application, "POST", "/internal/orchestrator/permission-reviews", {
    caller_session_id: highRisk?.approvalSessionId,
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

test("each approval review uses a fresh session while the logical approver shows one timeline", async () => {
  const adapter = new FakeAdapter()
  const application = createApplication({ config, adapter: adapter as unknown as OpenCodeAdapter })
  const created = await inject(application, "POST", "/api/task-groups", { title: "无状态审批测试" })
  const { taskGroup, agent: main, approver } = created.json as {
    taskGroup: { id: string }
    agent: { opencodeSessionId: string }
    approver: { id: string; opencodeSessionId: string }
  }

  const first = await application.permissionManager.ingest({
    id: "per_fresh_1",
    sessionID: main.opencodeSessionId,
    permission: "webfetch",
    resources: ["https://example.com/one"],
  })
  const second = await application.permissionManager.ingest({
    id: "per_fresh_2",
    sessionID: main.opencodeSessionId,
    permission: "finance_query",
    resources: ["revenue"],
  })
  assert.ok(first?.approvalSessionId)
  assert.ok(second?.approvalSessionId)
  assert.notEqual(first.approvalSessionId, second.approvalSessionId)
  assert.notEqual(first.approvalSessionId, approver.opencodeSessionId)
  assert.equal(adapter.sessions.filter((session) => session.parentID === main.opencodeSessionId).length, 2)

  const wrongCaller = await inject(application, "POST", "/internal/orchestrator/permission-reviews", {
    caller_session_id: second.approvalSessionId,
    permission_id: first.id,
    review: "approve_once",
    reason: "不应允许跨审批会话回调",
  })
  assert.equal(wrongCaller.statusCode, 403)

  const reviewed = await inject(application, "POST", "/internal/orchestrator/permission-reviews", {
    caller_session_id: first.approvalSessionId,
    permission_id: first.id,
    review: "approve_once",
    reason: "仅本次读取明确 URL",
  })
  assert.equal(reviewed.statusCode, 200)

  const duplicate = await inject(application, "POST", "/internal/orchestrator/permission-reviews", {
    caller_session_id: first.approvalSessionId,
    permission_id: first.id,
    review: "reject",
    reason: "第二次结论应被忽略",
  })
  assert.equal(duplicate.statusCode, 200)
  assert.equal((duplicate.json as { decision: string; approvalReview: string }).decision, "once")
  assert.equal((duplicate.json as { decision: string; approvalReview: string }).approvalReview, "approve_once")

  const timeline = await inject(application, "GET", "/api/agents/" + approver.id + "/messages")
  const messages = (timeline.json as { items: OpenCodeMessage[] }).items
  assert.equal(messages.filter((message) => message.info.role === "user").length, 2)
  assert.ok(messages.some((message) =>
    message.parts.some((part) => part.type === "tool" && part.tool === "review_permission"),
  ))
})

test("main Agent can replace the task-specific approval policy used by the approval Agent", async () => {
  const adapter = new FakeAdapter()
  const application = createApplication({ config, adapter: adapter as unknown as OpenCodeAdapter })
  const created = await inject(application, "POST", "/api/task-groups", { title: "动态审批策略测试" })
  const { taskGroup, agent: main, approver } = created.json as {
    taskGroup: { id: string }
    agent: { opencodeSessionId: string }
    approver: { opencodeSessionId: string }
  }

  const policy = "本任务只允许读取 workspace-template；任何网络访问都升级人工。"
  const updated = await inject(application, "POST", "/internal/orchestrator/set-approval-policy", {
    caller_session_id: main.opencodeSessionId,
    policy,
  })
  assert.equal(updated.statusCode, 200)
  assert.equal((updated.json as { policy: string }).policy, policy)

  const details = await inject(application, "GET", "/api/task-groups/" + taskGroup.id)
  assert.equal((details.json as { taskGroup: { approvalPolicy: string } }).taskGroup.approvalPolicy, policy)

  await application.permissionManager.ingest({
    id: "per_dynamic_policy",
    sessionID: main.opencodeSessionId,
    permission: "webfetch",
    resources: ["https://example.com"],
  })
  const review = adapter.prompts.find((prompt) => prompt.input.text.includes("任何网络访问都升级人工"))
  assert.ok(review)
  assert.match(review.input.text, /任何网络访问都升级人工/)
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
  const agentTypes = await inject(application, "POST", "/internal/orchestrator/list-agent-types", {
    caller_session_id: main.opencodeSessionId,
  })
  assert.deepEqual(
    (agentTypes.json as { items: Array<{ name: string }> }).items.map((item) => item.name),
    ["build", "control-plane-worker", "sql-investigator"],
  )
  const activeAgents = await inject(application, "POST", "/internal/orchestrator/list-active-agents", {
    caller_session_id: main.opencodeSessionId,
  })
  assert.equal((activeAgents.json as { items: unknown[] }).items.length, 1)
  const messaged = await inject(application, "POST", "/internal/orchestrator/message-worker", {
    caller_session_id: main.opencodeSessionId,
    worker_agent_id: worker.id,
    message: "再补充最近七天的样本。",
  })
  assert.equal(messaged.statusCode, 202)
  const followUp = adapter.prompts.find(
    (prompt) => prompt.sessionId === worker.opencodeSessionId && /最近七天/.test(prompt.input.text),
  )
  assert.ok(followUp)
  assert.equal(followUp.input.agent, "control-plane-worker")
})

test("complete team flow keeps every role in one workspace-scoped OpenCode runtime", async () => {
  const adapter = new FakeAdapter()
  const application = createApplication({ config, adapter: adapter as unknown as OpenCodeAdapter })

  const created = await inject(application, "POST", "/api/task-groups", { title: "完整流程验证" })
  const { taskGroup, agent: main, approver } = created.json as {
    taskGroup: { id: string }
    agent: { id: string; opencodeSessionId: string; opencodeAgentName: string }
    approver: { opencodeSessionId: string; opencodeAgentName: string }
  }
  assert.equal(main.opencodeAgentName, "control-plane-main")
  assert.equal(approver.opencodeAgentName, "permission-approver")

  const mainMessage = await inject(application, "POST", `/api/agents/${main.id}/messages`, {
    text: "检查费用口径，必要时创建 Worker。",
  })
  assert.equal(mainMessage.statusCode, 202)
  assert.equal(adapter.prompts.at(-1)?.input.agent, "control-plane-main")

  const types = await inject(application, "POST", "/internal/orchestrator/list-agent-types", {
    caller_session_id: main.opencodeSessionId,
  })
  assert.ok((types.json as { items: Array<{ name: string }> }).items.some((item) => item.name === "control-plane-worker"))

  const spawned = await inject(application, "POST", `/api/task-groups/${taskGroup.id}/workers`, {
    request_id: "complete-flow-worker",
    tasks: [{ field_key: "shipping", title: "履约费用", prompt: "核对履约费用口径" }],
  })
  assert.equal(spawned.statusCode, 201)
  const worker = (spawned.json as {
    agents: Array<{ id: string; opencodeSessionId: string; opencodeAgentName: string }>
  }).agents[0]
  assert.equal(worker.opencodeAgentName, "control-plane-worker")

  const directWorkerMessage = await inject(application, "POST", `/api/agents/${worker.id}/messages`, {
    text: "补充检查最近七天。",
  })
  assert.equal(directWorkerMessage.statusCode, 202)
  assert.equal(adapter.prompts.at(-1)?.input.agent, "control-plane-worker")

  const asked = await inject(application, "POST", "/internal/orchestrator/ask-main", {
    caller_session_id: worker.opencodeSessionId,
    question: "使用含税还是未税口径？",
  })
  const question = asked.json as { id: string }
  const answered = await inject(application, "POST", "/internal/orchestrator/answer-worker", {
    caller_session_id: main.opencodeSessionId,
    question_id: question.id,
    answer: "使用含税口径。",
  })
  assert.equal(answered.statusCode, 200)

  const readPermission = await application.permissionManager.ingest({
    id: "complete_flow_read",
    sessionID: worker.opencodeSessionId,
    permission: "read",
    patterns: ["docs/口径.md"],
  })
  assert.equal(readPermission?.decisionSource, "STATIC_POLICY")
  assert.equal(readPermission?.status, "APPROVED")

  const unknownPermission = await application.permissionManager.ingest({
    id: "complete_flow_unknown",
    sessionID: worker.opencodeSessionId,
    permission: "finance_query",
    patterns: ["shipping_cost"],
  })
  assert.equal(unknownPermission?.status, "PENDING")
  assert.equal(adapter.prompts.at(-1)?.sessionId, unknownPermission?.approvalSessionId)
  assert.equal(adapter.prompts.at(-1)?.input.agent, "permission-approver")
  const approved = await inject(application, "POST", "/internal/orchestrator/permission-reviews", {
    caller_session_id: unknownPermission?.approvalSessionId,
    permission_id: unknownPermission?.id,
    review: "approve_once",
    reason: "范围明确的单字段只读查询。",
  })
  assert.equal((approved.json as { status: string }).status, "APPROVED")

  const watch = await inject(application, "POST", "/internal/orchestrator/watch-job", {
    caller_session_id: worker.opencodeSessionId,
    title: "等待线上查询",
    delay_seconds: 60,
    wake_message: "查询履约费用任务状态并继续。",
    idempotency_key: "complete-flow-watch",
  })
  const wakeAt = (watch.json as { watch: { wakeAt: string } }).watch.wakeAt
  assert.equal(await application.watchJobManager.deliverDue(Date.parse(wakeAt)), 1)
  assert.equal(adapter.prompts.at(-1)?.sessionId, worker.opencodeSessionId)
  assert.equal(adapter.prompts.at(-1)?.input.agent, "control-plane-worker")

  const details = await inject(application, "GET", `/api/task-groups/${taskGroup.id}`)
  const detailBody = details.json as { agents: unknown[]; agentQuestions: Array<{ status: string }> }
  assert.equal(detailBody.agents.length, 3)
  assert.equal(detailBody.agentQuestions[0]?.status, "ANSWERED")
  application.watchJobManager.stop()
})

test("diff review blocks the tool call until the user approves or rejects the real file diff", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-diff-review-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, "example.before.ts"), "export const value = 1\n")
  writeFileSync(join(directory, "example.after.ts"), "export const value = 2\nexport const enabled = true\n")
  const adapter = new FakeAdapter()
  const application = createApplication({
    config: { ...config, opencodeDirectory: directory },
    adapter: adapter as unknown as OpenCodeAdapter,
  })
  const created = await inject(application, "POST", "/api/task-groups", { title: "代码修改审查" })
  const main = (created.json as { agent: { opencodeSessionId: string } }).agent

  const pendingRejection = inject(application, "POST", "/internal/orchestrator/diff-review", {
    caller_session_id: main.opencodeSessionId,
    summary: "调整示例值",
    comparisons: [{ before_file: "example.before.ts", after_file: "example.after.ts", label: "example.ts" }],
  })
  while (application.changeReviewManager.list().length === 0) await new Promise((resolve) => setTimeout(resolve, 1))
  const first = application.changeReviewManager.list()[0]
  assert.equal(first.additions, 2)
  assert.equal(first.deletions, 1)
  assert.match(first.files[0]?.diff ?? "", /\+export const enabled = true/)
  assert.deepEqual(first.files[0]?.rows, [
    {
      kind: "modified",
      beforeLine: 1,
      afterLine: 1,
      beforeText: "export const value = 1",
      afterText: "export const value = 2",
    },
    {
      kind: "added",
      beforeLine: undefined,
      afterLine: 2,
      beforeText: undefined,
      afterText: "export const enabled = true",
    },
  ])

  const rejected = await inject(application, "POST", `/api/change-reviews/${first.id}/decision`, {
    decision: "reject",
    rationale: "开关名称需要更明确",
  })
  assert.equal((rejected.json as { status: string }).status, "REJECTED")
  const rejectedResult = await pendingRejection
  assert.deepEqual(rejectedResult.json, {
    result: "rejected",
    reviewId: first.id,
    reason: "开关名称需要更明确",
  })

  writeFileSync(join(directory, "example.after.ts"), "export const value = 2\nexport const featureEnabled = true\n")
  const pendingApproval = inject(application, "POST", "/internal/orchestrator/diff-review", {
    caller_session_id: main.opencodeSessionId,
    summary: "按意见调整开关名称",
    comparisons: [{ before_file: "example.before.ts", after_file: "example.after.ts", label: "example.ts" }],
  })
  while (application.changeReviewManager.list().length < 2) await new Promise((resolve) => setTimeout(resolve, 1))
  const second = application.changeReviewManager.list()[0]
  const approved = await inject(application, "POST", `/api/change-reviews/${second.id}/decision`, {
    decision: "approve",
  })
  assert.equal((approved.json as { status: string }).status, "APPROVED")
  const approvedResult = await pendingApproval
  assert.deepEqual(approvedResult.json, { result: "ok", reviewId: second.id })
  assert.equal(adapter.prompts.some((prompt) => /Human (?:approved|rejected) change review/.test(prompt.input.text)), false)
})

test("watch_job persists a delayed wake-up and resumes the same Agent Session", async () => {
  const adapter = new FakeAdapter()
  const application = createApplication({ config, adapter: adapter as unknown as OpenCodeAdapter })
  const created = await inject(application, "POST", "/api/task-groups", { title: "长任务监控" })
  const { taskGroup, agent } = created.json as {
    taskGroup: { id: string }
    agent: { id: string; opencodeSessionId: string }
  }

  const scheduled = await inject(application, "POST", "/internal/orchestrator/watch-job", {
    caller_session_id: agent.opencodeSessionId,
    title: "线上报表生成",
    delay_seconds: 60,
    wake_message: "查询 job-2026 的运行状态；成功后读取结果并汇总。",
    idempotency_key: "job-2026-first-check",
  })
  assert.equal(scheduled.statusCode, 201)
  const body = scheduled.json as {
    created: boolean
    watch: { id: string; wakeAt: string; status: string; opencodeSessionId: string }
  }
  assert.equal(body.created, true)
  assert.equal(body.watch.status, "SCHEDULED")
  assert.equal(body.watch.opencodeSessionId, agent.opencodeSessionId)

  const duplicate = await inject(application, "POST", "/internal/orchestrator/watch-job", {
    caller_session_id: agent.opencodeSessionId,
    title: "不会重复创建",
    delay_seconds: 120,
    wake_message: "不会替换第一次登记的内容",
    idempotency_key: "job-2026-first-check",
  })
  assert.equal(duplicate.statusCode, 200)
  assert.equal((duplicate.json as { created: boolean }).created, false)

  assert.equal(await application.watchJobManager.deliverDue(Date.parse(body.watch.wakeAt)), 1)
  assert.equal(adapter.prompts.length, 1)
  assert.equal(adapter.prompts[0]?.sessionId, agent.opencodeSessionId)
  assert.match(adapter.prompts[0]?.input.text ?? "", /job-2026/)
  assert.match(adapter.prompts[0]?.input.text ?? "", /查询外部任务的真实状态/)
  assert.equal(adapter.prompts[0]?.input.agent, "control-plane-main")
  assert.equal(Object.hasOwn(adapter.prompts[0]?.input ?? {}, "tools"), false)

  const listed = await inject(application, "GET", `/api/job-watches?task_group_id=${taskGroup.id}`)
  const watches = (listed.json as { items: Array<{ id: string; status: string }> }).items
  assert.equal(watches.length, 1)
  assert.equal(watches[0]?.id, body.watch.id)
  assert.equal(watches[0]?.status, "DELIVERED")

  const cancellable = application.watchJobManager.schedule({
    callerSessionId: agent.opencodeSessionId,
    title: "可取消检查",
    wakeMessage: "不应发送",
    delaySeconds: 60,
  }).watch
  const cancelled = await inject(application, "POST", `/api/job-watches/${cancellable.id}/cancel`)
  assert.equal((cancelled.json as { status: string }).status, "CANCELLED")
  assert.equal(await application.watchJobManager.deliverDue(Date.parse(cancellable.wakeAt)), 0)
  application.watchJobManager.stop()
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
    tasks: [{ agentName: "sql-investigator", fieldKey: "ads", title: "广告费", prompt: "检查广告费" }],
  })
  const worker = first.attachWorker({
    taskId: reserved.tasks[0].id,
    parentAgentId: created.agent.id,
    sessionId: "ses_persisted_worker",
  }).agent
  assert.equal(worker.opencodeAgentName, "sql-investigator")
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
  const changeReview = first.createChangeReview({
    agent: worker,
    summary: "持久化审查",
    files: [{
      path: "src/example.ts",
      beforePath: "tmp/example.before.ts",
      afterPath: "src/example.ts",
      diff: "-old\n+new",
      additions: 1,
      deletions: 1,
      rows: [{ kind: "modified", beforeLine: 1, afterLine: 1, beforeText: "old", afterText: "new" }],
    }],
  })
  const jobWatch = first.createJobWatch({
    agent: created.agent,
    title: "持久化定时检查",
    wakeMessage: "查询线上任务状态",
    wakeAt: new Date(Date.now() + 60_000).toISOString(),
    idempotencyKey: "persisted-watch",
  }).watch
  first.close()

  second = new SqliteStore(databasePath)
  const restored = second.getTaskGroup(created.taskGroup.id)
  assert.equal(restored?.taskGroup.title, "持久化测试")
  assert.equal(restored?.agents.length, 2)
  assert.equal(second.listPermissionRequests({ status: "PENDING" }).length, 1)
  assert.equal(second.listAuditRecords().some((record) => record.type === "test.persisted"), true)
  assert.equal(second.getAgentQuestion(question.id)?.question, "持久化的问题")
  assert.equal(second.getChangeReview(changeReview.id)?.summary, "持久化审查")
  assert.equal(second.getJobWatch(jobWatch.id)?.wakeMessage, "查询线上任务状态")
  const repeated = second.reserveWorkerTasks({
    taskGroupId: created.taskGroup.id,
    requestId: "persistent-batch",
    tasks: [{ agentName: "build", fieldKey: "ignored", title: "不会重复", prompt: "不会重复" }],
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

test("application restart recovers scheduled watches and wakes the original Session", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-control-plane-watch-recovery-"))
  const databasePath = join(directory, "control-plane.sqlite")
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  const seed = new SqliteStore(databasePath)
  const created = seed.createTaskGroup({ title: "定时恢复测试", sessionId: "ses_watch_recovery" })
  const watch = seed.createJobWatch({
    agent: created.agent,
    title: "重启后的检查",
    wakeMessage: "读取 job-recovery 的最终结果",
    wakeAt: new Date(Date.now() + 30).toISOString(),
  }).watch
  seed.close()

  const adapter = new FakeAdapter()
  adapter.sessions.push({ id: created.agent.opencodeSessionId, title: created.taskGroup.title })
  const application = createApplication({
    config: { ...config, databasePath },
    adapter: adapter as unknown as OpenCodeAdapter,
  })
  await application.initialize()
  const deadline = Date.now() + 1_000
  while (adapter.prompts.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(adapter.prompts[0]?.sessionId, created.agent.opencodeSessionId)
  assert.match(adapter.prompts[0]?.input.text ?? "", /job-recovery/)
  assert.equal(application.store.getJobWatch(watch.id)?.status, "DELIVERED")
  await application.stop()
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
