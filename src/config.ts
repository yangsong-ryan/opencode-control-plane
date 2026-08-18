import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

export interface ControlPlaneConfig {
  host: string
  port: number
  opencodeBaseUrl: string
  opencodeDirectory: string
  opencodeUsername?: string
  opencodePassword?: string
  opencodeModel?: { providerID: string; modelID: string }
  maxConcurrentWorkers: number
  toolToken?: string
  maxRequestBytes: number
  databasePath: string
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid port: ${value}`)
  }
  return parsed
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`)
  }
  return parsed
}

function readProjectModel(directory: string): { providerID: string; modelID: string } | undefined {
  const path = resolve(directory, "opencode.json")
  if (!existsSync(path)) return undefined
  try {
    const config = JSON.parse(readFileSync(path, "utf8")) as { model?: unknown }
    if (typeof config.model !== "string") return undefined
    const separator = config.model.indexOf("/")
    if (separator <= 0 || separator === config.model.length - 1) return undefined
    return { providerID: config.model.slice(0, separator), modelID: config.model.slice(separator + 1) }
  } catch {
    return undefined
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControlPlaneConfig {
  const directory = env.OPENCODE_DIRECTORY ?? process.cwd()
  const baseUrl = env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096"
  const providerID = env.OPENCODE_PROVIDER_ID?.trim()
  const modelID = env.OPENCODE_MODEL_ID?.trim()
  if ((providerID === undefined) !== (modelID === undefined)) {
    throw new Error("OPENCODE_PROVIDER_ID and OPENCODE_MODEL_ID must be configured together")
  }

  const projectModel = providerID === undefined ? readProjectModel(directory) : undefined

  return {
    host: env.CONTROL_PLANE_HOST ?? "127.0.0.1",
    port: parsePort(env.CONTROL_PLANE_PORT, 4100),
    opencodeBaseUrl: new URL(baseUrl).toString().replace(/\/$/, ""),
    opencodeDirectory: directory,
    opencodeUsername: env.OPENCODE_SERVER_USERNAME,
    opencodePassword: env.OPENCODE_SERVER_PASSWORD,
    opencodeModel: providerID !== undefined && modelID !== undefined ? { providerID, modelID } : projectModel,
    maxConcurrentWorkers: parsePositiveInteger(env.MAX_CONCURRENT_WORKERS, 3),
    toolToken: env.CONTROL_PLANE_TOOL_TOKEN,
    maxRequestBytes: parsePositiveInteger(env.MAX_REQUEST_BYTES, 1_048_576),
    databasePath:
      env.CONTROL_PLANE_DATABASE_PATH === ":memory:"
        ? ":memory:"
        : resolve(env.CONTROL_PLANE_DATABASE_PATH ?? resolve(directory, ".data/opencode-control-plane.sqlite")),
  }
}
