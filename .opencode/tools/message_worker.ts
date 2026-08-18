import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Send supervisory guidance or follow-up work to one worker in this task group.",
  args: {
    worker_agent_id: tool.schema.string().describe("Control Plane worker Agent ID returned by list_workers"),
    message: tool.schema.string().describe("Guidance or follow-up instruction for the worker"),
  },
  async execute(args, context) {
    const baseUrl = process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:4100"
    const token = process.env.CONTROL_PLANE_TOOL_TOKEN
    const response = await fetch(`${baseUrl}/internal/orchestrator/message-worker`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-control-plane-token": token } : {}),
      },
      body: JSON.stringify({
        caller_session_id: context.sessionID,
        worker_agent_id: args.worker_agent_id,
        message: args.message,
      }),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`Control Plane rejected message_worker (${response.status}): ${body}`)
    return body
  },
})
