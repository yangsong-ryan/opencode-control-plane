import type { ControlPlaneConfig } from "./config.ts"
import { OpenCodeConnectionError, OpenCodeHttpError } from "./opencode-adapter.ts"

export function formatStartupError(error: unknown, config: ControlPlaneConfig): string {
  const lines: string[] = []

  if (error instanceof OpenCodeConnectionError) {
    lines.push(error.message)
    lines.push("")
    lines.push("OpenCode Server is not reachable at the configured address.")
    lines.push("Start it in a separate terminal:")
    lines.push("")
    lines.push("  opencode serve --hostname 127.0.0.1 --port 4096")
    lines.push("")
    lines.push(`Then verify: curl ${config.opencodeBaseUrl}/global/health`)
    lines.push("If OpenCode uses another port, set OPENCODE_BASE_URL before npm start.")
    return lines.join("\n")
  }

  if (error instanceof OpenCodeHttpError && error.status === 401) {
    lines.push(`OpenCode rejected the credentials at ${config.opencodeBaseUrl} (HTTP 401).`)
    lines.push("Use the same OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD for both processes.")
    return lines.join("\n")
  }

  if (error instanceof OpenCodeHttpError) {
    lines.push(error.message)
    if (error.body !== "") lines.push(error.body)
    return lines.join("\n")
  }

  return error instanceof Error ? error.stack ?? error.message : String(error)
}
