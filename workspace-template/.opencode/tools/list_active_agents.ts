import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "List reusable live worker Agent instances in this task group, including their OpenCode Agent type, current status, assignment, and open questions. Call this before spawn_workers.",
  args: {},
  async execute(_args, context) {
    const baseUrl = process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:4100"
    const token = process.env.CONTROL_PLANE_TOOL_TOKEN
    const response = await fetch(`${baseUrl}/internal/orchestrator/list-active-agents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-control-plane-token": token } : {}),
      },
      body: JSON.stringify({ caller_session_id: context.sessionID }),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`Control Plane rejected list_active_agents (${response.status}): ${body}`)
    return body
  },
})
