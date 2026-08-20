import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Schedule a durable wake-up for this same Agent Session and return immediately. Use it after starting a long-running external job; when the delay expires, the Control Plane sends wake_message back to this Session so you can query the real job status and continue.",
  args: {
    title: tool.schema.string().describe("Short name of the external job or follow-up"),
    delay_seconds: tool.schema.number().int().min(1).max(604800).describe("Seconds before this Agent is woken, from 1 second to 7 days"),
    wake_message: tool.schema.string().describe("What this Agent should check and continue doing when woken"),
    idempotency_key: tool.schema.string().optional().describe("Optional stable key that prevents duplicate schedules from a retried tool call"),
  },
  async execute(args, context) {
    const baseUrl = process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:4100"
    const token = process.env.CONTROL_PLANE_TOOL_TOKEN
    const response = await fetch(`${baseUrl}/internal/orchestrator/watch-job`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-control-plane-token": token } : {}),
      },
      body: JSON.stringify({ caller_session_id: context.sessionID, ...args }),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`Control Plane rejected watch_job (${response.status}): ${body}`)
    return body
  },
})
