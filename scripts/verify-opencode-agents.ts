import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const definitions = [
  {
    name: "control-plane-main",
    promptMarker: "NATIVE_MAIN_PROMPT_V2",
    enabled: ["list_agent_types", "list_active_agents", "set_approval_policy", "spawn_workers", "answer_worker", "list_workers", "message_worker", "diff_review", "watch_job"],
    disabled: ["task", "ask_main_agent", "review_permission"],
  },
  {
    name: "permission-approver",
    promptMarker: "NATIVE_APPROVER_PROMPT_V2",
    enabled: ["review_permission"],
    disabled: ["spawn_workers", "bash", "read", "edit", "question", "ask_main_agent", "diff_review"],
  },
  {
    name: "control-plane-worker",
    promptMarker: "NATIVE_WORKER_PROMPT_V1",
    enabled: ["ask_main_agent", "diff_review", "watch_job", "bash", "read"],
    disabled: ["task", "question", "list_agent_types", "list_active_agents", "set_approval_policy", "spawn_workers", "answer_worker", "list_workers", "message_worker", "review_permission"],
  },
] as const

const runtimeDirectory = mkdtempSync(join(tmpdir(), "opencode-agent-config-probe-"))
const workspaceDirectory = resolve(process.env.OPENCODE_DIRECTORY ?? join(process.cwd(), "workspace-template"))

try {
  for (const name of ["data", "state", "cache"]) mkdirSync(join(runtimeDirectory, name))
  const workspacePlugin = join(workspaceDirectory, ".opencode", "node_modules", "@opencode-ai", "plugin")
  if (!existsSync(workspacePlugin)) {
    throw new Error(`Workspace dependency is missing. Run: npm install --prefix ${join(workspaceDirectory, ".opencode")}`)
  }
  const inspectionWorkspace = join(runtimeDirectory, "workspace")
  const inspectionConfig = join(inspectionWorkspace, ".opencode")
  mkdirSync(inspectionConfig, { recursive: true })
  const projectConfig = JSON.parse(readFileSync(join(workspaceDirectory, "opencode.json"), "utf8")) as Record<string, unknown>
  delete projectConfig.model
  writeFileSync(join(inspectionWorkspace, "opencode.json"), JSON.stringify(projectConfig, null, 2))
  cpSync(join(workspaceDirectory, ".opencode", "tools"), join(inspectionConfig, "tools"), { recursive: true })
  cpSync(join(workspaceDirectory, ".opencode", "node_modules"), join(inspectionConfig, "node_modules"), { recursive: true })
  for (const name of ["package.json", "package-lock.json"]) {
    const source = join(workspaceDirectory, ".opencode", name)
    if (existsSync(source)) cpSync(source, join(inspectionConfig, name))
  }
  const report = definitions.map((definition) => {
    const result = spawnSync("opencode", ["debug", "agent", definition.name], {
      cwd: inspectionWorkspace,
      encoding: "utf8",
      env: {
        ...process.env,
        XDG_DATA_HOME: join(runtimeDirectory, "data"),
        XDG_STATE_HOME: join(runtimeDirectory, "state"),
        XDG_CACHE_HOME: join(runtimeDirectory, "cache"),
        OPENCODE_DISABLE_MODELS_FETCH: "true",
      },
    })
    if (result.status !== 0) throw new Error(result.stderr || `Unable to inspect ${definition.name}`)
    const agent = JSON.parse(result.stdout) as {
      name: string
      native?: boolean
      prompt?: string
      permission?: Array<{ permission: string; action: string; pattern: string }>
      tools?: Record<string, boolean>
    }
    const tools = agent.tools ?? {}
    const enabledMissing = definition.enabled.filter((name) => tools[name] !== true)
    const disabledLeaked = definition.disabled.filter((name) => tools[name] !== false)
    const promptInjected = agent.prompt?.includes(definition.promptMarker) === true
    return {
      agent: definition.name,
      loadedByOpenCode: agent.name === definition.name && agent.native === false,
      promptInjected,
      enabledToolsVerified: definition.enabled.filter((name) => tools[name] === true),
      enabledMissing,
      disabledToolsVerified: definition.disabled.filter((name) => tools[name] === false),
      disabledLeaked,
      visibleTools: Object.entries(tools).filter(([, visible]) => visible).map(([name]) => name).sort(),
      resolvedPermissionRuleCount: agent.permission?.length ?? 0,
    }
  })
  console.log(JSON.stringify(report, null, 2))
  const failed = report.some((item) => !item.loadedByOpenCode || !item.promptInjected || item.enabledMissing.length > 0 || item.disabledLeaked.length > 0)
  if (failed) process.exitCode = 1
} finally {
  rmSync(runtimeDirectory, { recursive: true, force: true })
}
