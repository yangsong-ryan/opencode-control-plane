import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Create independent OpenCode worker sessions only after list_agent_types and list_active_agents confirm that no suitable existing worker can be reused. tasks must be a real array of objects; never JSON.stringify it or pass a JSON string.",
  args: {
    request_id: tool.schema.string().describe("A stable unique ID. Reuse it when retrying the same batch."),
    tasks: tool.schema
      .array(
        tool.schema.object({
          agent_name: tool.schema.string().describe("Exact OpenCode Agent name returned by list_agent_types"),
          field_key: tool.schema.string().describe("Stable machine-readable field identifier"),
          title: tool.schema.string().describe("Short worker display name"),
          prompt: tool.schema.string().describe("Complete self-contained investigation prompt for this worker"),
        }),
      )
      .min(1)
      .max(20),
  },
  async execute(args, context) {
    if (!Array.isArray(args.tasks)) {
      throw new Error(
        'spawn_workers requires tasks to be an actual array, for example tasks: [{"agent_name":"control-plane-worker","field_key":"worker_a","title":"Worker A","prompt":"Complete assignment"}]. Do not wrap the array in a string.',
      )
    }
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
