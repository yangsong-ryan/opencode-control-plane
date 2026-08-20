import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "List the OpenCode Agent definitions available in the current project. Call this before choosing an agent_name for spawn_workers.",
  args: {},
  async execute(_args, context) {
    const baseUrl = process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:4100"
    const token = process.env.CONTROL_PLANE_TOOL_TOKEN
    const response = await fetch(`${baseUrl}/internal/orchestrator/list-agent-types`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-control-plane-token": token } : {}),
      },
      body: JSON.stringify({ caller_session_id: context.sessionID }),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`Control Plane rejected list_agent_types (${response.status}): ${body}`)
    return body
  },
})
