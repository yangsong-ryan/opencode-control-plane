import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Replace this Agent Team's task-specific permission approval policy when the user states approval boundaries or risk requirements.",
  args: {
    policy: tool.schema
      .string()
      .min(1)
      .max(8000)
      .describe("Complete task-specific approval principles for the dedicated approval Agent"),
  },
  async execute(args, context) {
    const baseUrl = process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:4100"
    const token = process.env.CONTROL_PLANE_TOOL_TOKEN
    const response = await fetch(`${baseUrl}/internal/orchestrator/set-approval-policy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-control-plane-token": token } : {}),
      },
      body: JSON.stringify({ caller_session_id: context.sessionID, policy: args.policy }),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`Control Plane rejected set_approval_policy (${response.status}): ${body}`)
    return body
  },
})
