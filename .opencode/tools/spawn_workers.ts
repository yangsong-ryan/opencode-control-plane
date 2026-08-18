import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Create the independent OpenCode worker sessions that you, as the main Agent, decided are useful for this task. The user does not choose the worker count.",
  args: {
    request_id: tool.schema.string().describe("A stable unique ID. Reuse it when retrying the same batch."),
    tasks: tool.schema
      .array(
        tool.schema.object({
          field_key: tool.schema.string().describe("Stable machine-readable field identifier"),
          title: tool.schema.string().describe("Short worker display name"),
          prompt: tool.schema.string().describe("Complete self-contained investigation prompt for this worker"),
        }),
      )
      .min(1)
      .max(20),
  },
  async execute(args, context) {
    const baseUrl = process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:4100"
    const token = process.env.CONTROL_PLANE_TOOL_TOKEN
    const response = await fetch(`${baseUrl}/internal/orchestrator/spawn-workers`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-control-plane-token": token } : {}),
      },
      body: JSON.stringify({
        caller_session_id: context.sessionID,
        request_id: args.request_id,
        tasks: args.tasks,
      }),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`Control Plane rejected spawn_workers (${response.status}): ${body}`)
    return body
  },
})
