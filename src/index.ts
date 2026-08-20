import { loadConfig } from "./config.ts"
import { createApplication } from "./app.ts"
import { formatStartupError } from "./diagnostics.ts"

const config = loadConfig()
const application = createApplication({ config })

const shutdown = async (signal: string): Promise<void> => {
  process.stdout.write(`\nReceived ${signal}; shutting down...\n`)
  await application.stop()
  process.exitCode = 0
}

process.once("SIGINT", () => void shutdown("SIGINT"))
process.once("SIGTERM", () => void shutdown("SIGTERM"))

try {
  const address = await application.start()
  process.stdout.write(`OpenCode Control Plane listening at http://${address.host}:${address.port}\n`)
  process.stdout.write(
    `Connected to OpenCode ${application.capabilities?.version ?? "unknown"} at ${config.opencodeBaseUrl}\n`,
  )
  process.stdout.write(
    `Model: ${config.opencodeModel === undefined ? "OpenCode default" : `${config.opencodeModel.providerID}/${config.opencodeModel.modelID}`}\n`,
  )
  process.stdout.write(`Team workspace: ${config.opencodeDirectory}\n`)
  process.stdout.write(`State database: ${config.databasePath}\n`)
} catch (error) {
  process.stderr.write(`${formatStartupError(error, config)}\n`)
  process.exitCode = 1
}
