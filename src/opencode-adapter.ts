export interface OpenCodeCapabilities {
  healthy: boolean
  version: string
  routes: {
    listAgents: boolean
    createSession: boolean
    listSessions: boolean
    listMessages: boolean
    promptAsync: boolean
    abortSession: boolean
    events: boolean
    permissionList: boolean
    permissionReply: boolean
    v2PermissionReply: boolean
  }
}

export interface OpenCodeSession {
  id: string
  title?: string
  parentID?: string
  directory?: string
  [key: string]: unknown
}

export interface OpenCodeMessage {
  info: Record<string, unknown>
  parts: Array<Record<string, unknown>>
}

export interface OpenCodeAgentInfo {
  name: string
  description?: string
  mode?: "primary" | "subagent" | "all"
  hidden?: boolean
  native?: boolean
  model?: { providerID?: string; modelID?: string; id?: string } | string
  [key: string]: unknown
}

export interface SendMessageInput {
  text: string
  agent?: string
  model?: { providerID: string; modelID: string }
  system?: string
}

export type OpenCodePermissionDecision = "once" | "always" | "reject"

export interface OpenCodePermissionRequest {
  id: string
  sessionID: string
  permission?: string
  patterns?: string[]
  always?: string[]
  action?: string
  resources?: string[]
  save?: string[]
  metadata?: Record<string, unknown>
  source?: Record<string, unknown>
  tool?: Record<string, unknown>
}

export interface OpenCodePermissionRule {
  permission: string
  pattern: string
  action: "allow" | "ask" | "deny"
}

export interface OpenCodeAdapterOptions {
  baseUrl: string
  directory: string
  username?: string
  password?: string
  fetchImpl?: typeof fetch
}

export class OpenCodeHttpError extends Error {
  readonly status: number
  readonly body: string

  constructor(message: string, status: number, body: string) {
    super(message)
    this.name = "OpenCodeHttpError"
    this.status = status
    this.body = body
  }
}

export class OpenCodeConnectionError extends Error {
  readonly endpoint: string
  readonly detail: string

  constructor(endpoint: string, detail: string, cause: unknown) {
    super(`Cannot reach OpenCode at ${endpoint}: ${detail}`, { cause })
    this.name = "OpenCodeConnectionError"
    this.endpoint = endpoint
    this.detail = detail
  }
}

function connectionErrorDetail(error: unknown): string {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error
  if (cause !== null && typeof cause === "object") {
    const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined
    const message = "message" in cause && typeof cause.message === "string" ? cause.message : undefined
    if (code !== undefined && message !== undefined) return `${code} (${message})`
    if (code !== undefined) return code
    if (message !== undefined) return message
  }
  return error instanceof Error ? error.message : String(error)
}

function routeSignature(route: string): string {
  return route.replaceAll(/\{[^}]+\}/g, "{param}").replaceAll(/:[^/]+/g, "{param}")
}

function routeExists(specText: string, method: string, routes: string[]): boolean {
  try {
    const parsed = JSON.parse(specText) as { paths?: Record<string, Record<string, unknown>> }
    for (const [path, operations] of Object.entries(parsed.paths ?? {})) {
      if (
        routes.some((route) => routeSignature(route) === routeSignature(path)) &&
        Object.hasOwn(operations, method.toLowerCase())
      ) {
        return true
      }
    }
    return false
  } catch {
    return routes.some((route) => specText.includes(route))
  }
}

function parseSseBlock(block: string): { event?: string; id?: string; data: string } | undefined {
  const lines = block.split("\n")
  const data: string[] = []
  let event: string | undefined
  let id: string | undefined

  for (const line of lines) {
    if (line === "" || line.startsWith(":")) continue
    const separator = line.indexOf(":")
    const field = separator === -1 ? line : line.slice(0, separator)
    let value = separator === -1 ? "" : line.slice(separator + 1)
    if (value.startsWith(" ")) value = value.slice(1)

    if (field === "data") data.push(value)
    else if (field === "event") event = value
    else if (field === "id") id = value
  }

  if (data.length === 0) return undefined
  return { event, id, data: data.join("\n") }
}

export class OpenCodeAdapter {
  private readonly baseUrl: string
  private readonly directory: string
  private readonly username?: string
  private readonly password?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: OpenCodeAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "")
    this.directory = options.directory
    this.username = options.username
    this.password = options.password
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private url(path: string, directoryScoped = true): URL {
    const url = new URL(path, `${this.baseUrl}/`)
    if (directoryScoped) url.searchParams.set("directory", this.directory)
    return url
  }

  private headers(json = false): Headers {
    const headers = new Headers({
      accept: "application/json",
      "x-opencode-directory": encodeURIComponent(this.directory),
    })
    if (json) headers.set("content-type", "application/json")
    if (this.password !== undefined) {
      const username = this.username ?? "opencode"
      headers.set("authorization", `Basic ${Buffer.from(`${username}:${this.password}`).toString("base64")}`)
    }
    return headers
  }

  private async request(path: string, init: RequestInit = {}, directoryScoped = true): Promise<Response> {
    const url = this.url(path, directoryScoped)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: init.headers ?? this.headers(init.body !== undefined),
      })
    } catch (error) {
      const endpoint = `${url.origin}${url.pathname}`
      throw new OpenCodeConnectionError(endpoint, connectionErrorDetail(error), error)
    }
    if (!response.ok) {
      const body = await response.text()
      throw new OpenCodeHttpError(
        `OpenCode request failed: ${init.method ?? "GET"} ${path} (${response.status})`,
        response.status,
        body,
      )
    }
    return response
  }

  async probeCapabilities(): Promise<OpenCodeCapabilities> {
    const [healthResponse, specResponse] = await Promise.all([
      this.request("/global/health", {}, false),
      this.request("/doc", {}, false),
    ])
    const health = (await healthResponse.json()) as { healthy?: boolean; version?: string }
    const specText = await specResponse.text()

    return {
      healthy: health.healthy === true,
      version: health.version ?? "unknown",
      routes: {
        listAgents: routeExists(specText, "get", ["/agent", "/api/agent"]),
        createSession: routeExists(specText, "post", ["/session"]),
        listSessions: routeExists(specText, "get", ["/session"]),
        listMessages: routeExists(specText, "get", [
          "/session/{sessionID}/message",
          "/session/{id}/message",
        ]),
        promptAsync: routeExists(specText, "post", [
          "/session/{sessionID}/prompt_async",
          "/session/{id}/prompt_async",
        ]),
        abortSession: routeExists(specText, "post", [
          "/session/{sessionID}/abort",
          "/session/{id}/abort",
        ]),
        events: routeExists(specText, "get", ["/event", "/global/event"]),
        permissionList: routeExists(specText, "get", ["/permission", "/api/permission/request"]),
        permissionReply: routeExists(specText, "post", [
          "/permission/{requestID}/reply",
          "/api/session/{sessionID}/permission/{requestID}/reply",
          "/session/{sessionID}/permissions/{permissionID}",
        ]),
        v2PermissionReply: routeExists(specText, "post", [
          "/api/session/{sessionID}/permission/{requestID}/reply",
        ]),
      },
    }
  }

  async createSession(input: {
    title: string
    parentSessionId?: string
    model?: { providerID: string; modelID: string }
    permission?: OpenCodePermissionRule[]
  }): Promise<OpenCodeSession> {
    const response = await this.request("/session", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        title: input.title,
        parentID: input.parentSessionId,
        model:
          input.model === undefined
            ? undefined
            : { providerID: input.model.providerID, id: input.model.modelID },
        permission: input.permission,
      }),
    })
    return (await response.json()) as OpenCodeSession
  }

  async listSessions(): Promise<OpenCodeSession[]> {
    const response = await this.request("/session")
    return (await response.json()) as OpenCodeSession[]
  }

  async listAgents(): Promise<OpenCodeAgentInfo[]> {
    try {
      const response = await this.request("/agent")
      return (await response.json()) as OpenCodeAgentInfo[]
    } catch (error) {
      if (!(error instanceof OpenCodeHttpError) || error.status !== 404) throw error
      const response = await this.request("/api/agent")
      const body = (await response.json()) as OpenCodeAgentInfo[] | { data?: OpenCodeAgentInfo[] }
      return Array.isArray(body) ? body : body.data ?? []
    }
  }

  async listMessages(sessionId: string): Promise<OpenCodeMessage[]> {
    const response = await this.request(`/session/${encodeURIComponent(sessionId)}/message`)
    return (await response.json()) as OpenCodeMessage[]
  }

  async sendAsync(sessionId: string, input: SendMessageInput): Promise<void> {
    await this.request(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        agent: input.agent,
        model: input.model,
        system: input.system,
        parts: [{ type: "text", text: input.text }],
      }),
    })
  }

  async abortSession(sessionId: string): Promise<boolean> {
    const response = await this.request(`/session/${encodeURIComponent(sessionId)}/abort`, {
      method: "POST",
      headers: this.headers(false),
    })
    return (await response.json()) as boolean
  }

  async listPendingPermissions(): Promise<OpenCodePermissionRequest[]> {
    try {
      const response = await this.request("/permission")
      return (await response.json()) as OpenCodePermissionRequest[]
    } catch (error) {
      if (!(error instanceof OpenCodeHttpError) || error.status !== 404) throw error
      const response = await this.request("/api/permission/request")
      const body = (await response.json()) as { data?: OpenCodePermissionRequest[] }
      return body.data ?? []
    }
  }

  async replyPermission(input: {
    sessionId: string
    requestId: string
    decision: OpenCodePermissionDecision
    message?: string
  }): Promise<void> {
    try {
      await this.request(`/permission/${encodeURIComponent(input.requestId)}/reply`, {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ reply: input.decision, message: input.message }),
      })
      return
    } catch (error) {
      if (!(error instanceof OpenCodeHttpError) || error.status !== 404) throw error
    }

    await this.request(
      `/api/session/${encodeURIComponent(input.sessionId)}/permission/${encodeURIComponent(input.requestId)}/reply`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ reply: input.decision, message: input.message }),
      },
      false,
    )
  }

  async subscribeEvents(
    onEvent: (event: unknown) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.request(
      "/event",
      { headers: this.headers(false), signal },
      true,
    )
    if (response.body === null) throw new Error("OpenCode event response did not include a body")

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n")

        let boundary = buffer.indexOf("\n\n")
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const parsed = parseSseBlock(block)
          if (parsed !== undefined) {
            let payload: unknown = parsed.data
            try {
              payload = JSON.parse(parsed.data)
            } catch {
              // Non-JSON events are forwarded as text so callers can still inspect them.
            }
            await onEvent(payload)
          }
          boundary = buffer.indexOf("\n\n")
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
}
