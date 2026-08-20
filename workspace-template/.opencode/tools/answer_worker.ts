import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Answer one open question from a worker you supervise and resume that worker with your guidance.",
  args: {
    question_id: tool.schema.string().describe("Question ID supplied in the worker question message"),
    answer: tool.schema.string().describe("Clear, actionable answer for the worker"),
  },
  async execute(args, context) {
    const baseUrl = process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:4100"
    const token = process.env.CONTROL_PLANE_TOOL_TOKEN
    const response = await fetch(`${baseUrl}/internal/orchestrator/answer-worker`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-control-plane-token": token } : {}),
      },
      body: JSON.stringify({ caller_session_id: context.sessionID, question_id: args.question_id, answer: args.answer }),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`Control Plane rejected answer_worker (${response.status}): ${body}`)
    return body
  },
})
