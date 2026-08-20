import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Ask this task group's main Agent for guidance when you are blocked or need a supervisory decision.",
  args: {
    question: tool.schema.string().describe("One concise question that the main Agent can answer"),
    context: tool.schema.string().optional().describe("Evidence, attempts, or alternatives relevant to the question"),
  },
  async execute(args, context) {
    const baseUrl = process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:4100"
    const token = process.env.CONTROL_PLANE_TOOL_TOKEN
    const response = await fetch(`${baseUrl}/internal/orchestrator/ask-main`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-control-plane-token": token } : {}),
      },
      body: JSON.stringify({ caller_session_id: context.sessionID, question: args.question, context: args.context }),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`Control Plane rejected ask_main_agent (${response.status}): ${body}`)
    return body
  },
})
