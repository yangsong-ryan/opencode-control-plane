import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Compare real before/after files and wait for human confirmation. The call returns result=ok only after the user accepts the displayed diff. Submission and publishing remain the Agent's responsibility.",
  args: {
    summary: tool.schema.string().describe("Short description shown above the diff"),
    comparisons: tool.schema.array(tool.schema.object({
      before_file: tool.schema.string().describe("Workspace-relative path to the file before modification"),
      after_file: tool.schema.string().describe("Workspace-relative path to the file after modification"),
      label: tool.schema.string().optional().describe("Optional display name"),
    })).max(30),
  },
  async execute(args, context) {
    const baseUrl = process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:4100"
    const token = process.env.CONTROL_PLANE_TOOL_TOKEN
    const response = await fetch(`${baseUrl}/internal/orchestrator/diff-review`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-control-plane-token": token } : {}),
      },
      body: JSON.stringify({ caller_session_id: context.sessionID, ...args }),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`Control Plane rejected diff_review (${response.status}): ${body}`)
    return body
  },
})
