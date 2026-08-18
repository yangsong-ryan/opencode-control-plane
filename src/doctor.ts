import { loadConfig } from "./config.ts"
import { formatStartupError } from "./diagnostics.ts"
import { OpenCodeAdapter } from "./opencode-adapter.ts"

const config = loadConfig()
const adapter = new OpenCodeAdapter({
  baseUrl: config.opencodeBaseUrl,
  directory: config.opencodeDirectory,
  username: config.opencodeUsername,
  password: config.opencodePassword,
})

process.stdout.write(`OpenCode URL: ${config.opencodeBaseUrl}\n`)
process.stdout.write(`Workspace: ${config.opencodeDirectory}\n`)
process.stdout.write(`Database: ${config.databasePath}\n`)
process.stdout.write(
  `Model override: ${config.opencodeModel ? `${config.opencodeModel.providerID}/${config.opencodeModel.modelID}` : "OpenCode default"}\n`,
)

try {
  const capabilities = await adapter.probeCapabilities()
  process.stdout.write(`Connected to OpenCode ${capabilities.version}.\n`)
  process.stdout.write(`${JSON.stringify(capabilities.routes, null, 2)}\n`)
  process.exitCode = 0
} catch (error) {
  process.stderr.write(`${formatStartupError(error, config)}\n`)
  process.exitCode = 1
}
