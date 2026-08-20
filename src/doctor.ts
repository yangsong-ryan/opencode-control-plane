import { existsSync } from "node:fs"
import { join } from "node:path"
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
  if (!existsSync(config.opencodeDirectory)) throw new Error(`Workspace does not exist: ${config.opencodeDirectory}`)
  const configFile = ["opencode.json", "opencode.jsonc"]
    .map((name) => join(config.opencodeDirectory, name))
    .find((path) => existsSync(path))
  if (configFile === undefined) throw new Error(`Workspace has no opencode.json or opencode.jsonc: ${config.opencodeDirectory}`)
  const toolsDirectory = join(config.opencodeDirectory, ".opencode", "tools")
  if (!existsSync(toolsDirectory)) throw new Error(`Workspace has no Control Plane tools directory: ${toolsDirectory}`)

  const capabilities = await adapter.probeCapabilities()
  const agents = await adapter.listAgents()
  const names = new Set(agents.map((agent) => agent.name))
  const missingAgents = [config.mainAgentName, config.approvalAgentName, config.defaultWorkerAgentName]
    .filter((name) => !names.has(name))
  if (missingAgents.length > 0) throw new Error(`OpenCode did not load required workspace Agents: ${missingAgents.join(", ")}`)
  process.stdout.write(`Connected to OpenCode ${capabilities.version}.\n`)
  process.stdout.write(`Workspace config: ${configFile}\n`)
  process.stdout.write(`Workspace tools: ${toolsDirectory}\n`)
  process.stdout.write(`Agents: ${[config.mainAgentName, config.approvalAgentName, config.defaultWorkerAgentName].join(", ")}\n`)
  process.stdout.write(`${JSON.stringify(capabilities.routes, null, 2)}\n`)
  process.exitCode = 0
} catch (error) {
  process.stderr.write(`${formatStartupError(error, config)}\n`)
  process.exitCode = 1
}
