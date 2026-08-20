import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Submit the dedicated approval Agent's decision for one pending OpenCode permission request.",
  args: {
    permission_id: tool.schema.string().describe("Control Plane permission ID from the review message"),
    review: tool.schema
      .enum(["approve_once", "reject", "escalate"])
      .describe("Approve once, reject, or escalate to the human. Persistent permission is never available."),
    reason: tool.schema.string().describe("Concise evidence-based reason for the decision"),
  },
  async execute(args, context) {
    const baseUrl = process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:4100"
    const token = process.env.CONTROL_PLANE_TOOL_TOKEN
    const response = await fetch(`${baseUrl}/internal/orchestrator/permission-reviews`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-control-plane-token": token } : {}),
      },
      body: JSON.stringify({
        caller_session_id: context.sessionID,
        permission_id: args.permission_id,
        review: args.review,
        reason: args.reason,
      }),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`Control Plane rejected review_permission (${response.status}): ${body}`)
    return body
  },
})
