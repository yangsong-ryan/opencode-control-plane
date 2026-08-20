# OpenCode Control Plane

一个建立在 OpenCode 原生 Session、Agent、工具和权限系统之上的 Agent Teams 管理服务。你只需要和主 Agent 对话；主 Agent 可以发现、创建、复用和监督独立 Worker，Worker 可以继续向主 Agent提问，权限请求则由静态规则、专用审批 Agent 和人工三层处理。

## 它解决什么问题

- 把“手工打开多个 OpenCode 窗口”变成一个可管理的 Agent Team。
- 主 Agent 根据任务自行决定是否创建 Worker、创建多少个、选择哪种 Agent。
- 每个 Worker 都是独立且可继续对话的 OpenCode Session，不是一次性文本结果。
- 用户可以随时在页面切换主 Agent 或 Worker，查看 Markdown、工具调用、权限和运行状态。
- OpenCode 继续负责模型、上下文、工具执行和原生 Agent 权限；Control Plane 只补充团队编排能力。

## 项目结构与工作空间

项目逻辑上分成后端和团队工作空间两部分：

```text
opencode-control-plane/
├── src/、package.json、docs/       # Control Plane 后端与 Web 页面
├── .data/                          # 本机 SQLite 运行数据，不提交 Git
└── workspace-template/             # 可提交 GitHub 的团队工作空间模板
    ├── opencode.json               # 模型、Agent、工具权限
    ├── .opencode/agents/           # 可选：Markdown Agent
    ├── .opencode/skills/           # 可选：项目 Skill
    ├── .opencode/tools/            # Control Plane 工具桥接
    └── 业务代码、脚本和资料
```

开发和快速测试可以直接使用仓库中的 [workspace-template](workspace-template/)。长期使用或生产部署建议把它复制到后端目录之外，再通过 `OPENCODE_DIRECTORY` 指向复制后的绝对路径。后端从哪里启动并不决定 Agent 的工作目录；`OPENCODE_DIRECTORY` 才决定 OpenCode 加载哪个项目配置以及 Agent 在哪里工作。

## 快速开始

### 1. 准备环境

- Node.js 24 或更高版本；
- OpenCode 1.17.15 或兼容版本；
- 至少一个已经配置好凭证的 OpenCode Provider。

确认版本和可用模型：

```bash
node --version
opencode --version
opencode models
```

### 2. 安装依赖

```bash
git clone <你的 GitHub 仓库地址>
cd opencode-control-plane
npm install
npm install --prefix "$PWD/workspace-template/.opencode"
```

模板当前在 [workspace-template/opencode.json](workspace-template/opencode.json) 中使用 `ali/qwen3-coder-plus`。如果目标电脑没有该 Provider，请先把 `model` 改为 `opencode models` 输出中的可用模型。

### 3. 启动 OpenCode Server

终端 A：

```bash
OPENCODE_SERVER_PASSWORD=change-me \
CONTROL_PLANE_URL=http://127.0.0.1:4100 \
CONTROL_PLANE_TOOL_TOKEN=change-tool-token \
opencode serve --hostname 127.0.0.1 --port 4096
```

### 4. 诊断并启动 Control Plane

终端 B：

```bash
OPENCODE_BASE_URL=http://127.0.0.1:4096 \
OPENCODE_SERVER_PASSWORD=change-me \
CONTROL_PLANE_TOOL_TOKEN=change-tool-token \
OPENCODE_DIRECTORY="$PWD/workspace-template" \
npm run doctor

OPENCODE_BASE_URL=http://127.0.0.1:4096 \
OPENCODE_SERVER_PASSWORD=change-me \
CONTROL_PLANE_TOOL_TOKEN=change-tool-token \
OPENCODE_DIRECTORY="$PWD/workspace-template" \
npm start
```

打开 <http://127.0.0.1:4100>，创建一个新的 Agent Team，然后只需要给主 Agent 下达完整任务。重启或更换 OpenCode Server 后，如果历史团队显示 Session 已失效，应创建新团队，不要继续向失效 Session 发送消息。

## 功能一览

| 能力 | 用户看到的效果 |
|---|---|
| Agent Team | 一个主 Agent 管理多个可持续对话的独立 Worker |
| 主从通信 | Worker 通过工具询问主 Agent，主 Agent 可回答或主动追问 |
| 原生 Agent 配置 | 使用 OpenCode `opencode.json` 或 Markdown Agent 控制提示词和工具权限 |
| 三层权限审批 | 静态规则 → 专用审批 Agent → 必要时人工接管 |
| Web 工作台 | 切换 Agent、Markdown 消息、折叠工具、停止本轮、查看权限状态 |
| Diff 人工确认 | 左右分栏展示真实文件差异，用户确认后工具向 Agent 返回 `ok` |
| Watch Job | 长任务到期后自动唤醒原 Session 继续查询结果 |
| 持久化恢复 | SQLite 保存团队、Worker、权限、审计、Diff 与定时任务 |

## 修改或新增 Agent

默认的主 Agent、审批 Agent 和通用 Worker 位于 [workspace-template/opencode.json](workspace-template/opencode.json) 的 `agent` 字段。可以直接修改它们的：

- `description`：供主 Agent 识别用途；
- `mode`：`primary`、`subagent` 或 `all`；
- `prompt`：该 Agent 的原生角色提示词；
- `permission`：决定工具是否可见，以及调用时是 `allow`、`ask` 还是 `deny`。

新增业务 Agent 也可以创建：

```text
workspace-template/.opencode/agents/<agent-name>.md
```

修改 Agent、工具或 Skill 后，重启 OpenCode Server，运行 `npm run doctor`，再重启 Control Plane。后端发送消息时只传 Agent 名称，不会用硬编码工具列表覆盖工作空间配置。完整示例见下方[定义可调度的 OpenCode Agent](#定义可调度的-opencode-agent)和[工作空间说明](workspace-template/README.md)。

## 文档导航

- [安装、工作空间与生产部署](docs/deployment.md)
- [发布到 GitHub](docs/github-publishing.md)
- [底层架构与目录路由](docs/architecture.md)
- [自动测试与 Agent 权限验证](docs/verification.md)
- [工作空间模板说明](workspace-template/README.md)

## 详细功能

- 启动时探测 OpenCode 健康状态、版本和 OpenAPI 路由。
- 创建 TaskGroup，并自动创建独立的主 Agent Session 和权限审批 Agent Session。
- 向主 Agent 异步发送消息。
- 加载完整 OpenCode 消息历史。
- 中止主 Agent 当前运行。
- 消费 OpenCode SSE，并通过 Control Plane SSE 转发给浏览器。
- 浏览器不直接持有 OpenCode 地址或凭证。
- 主 Agent 按任务需要自主创建独立 Worker Session，并给 OpenCode 设置主 Session `parentID`。
- 相同 `request_id` 的 Worker 批次自动去重。
- Worker 创建遵守可配置的并发上限。
- 项目级 `spawn_workers` Custom Tool 允许主 Agent 自主决定 Worker 数量并发起分工。
- 主 Agent、审批 Agent 和默认 Worker 都是 `opencode.json` 中的原生命名 Agent；后端通过消息请求里的 `agent` 名称选择它们。
- 工具可见性与基础权限完全由 OpenCode Agent 的 `permission` 配置决定；后端不再注入 Prompt 级 `tools` 或 Session 级权限覆盖。
- 同时兼容 OpenCode 1.17.15 的传统权限接口和 V2 权限事件。
- Worker 使用明确选择的 OpenCode Agent 定义；需要开放 `ask_main_agent`、禁用 `question` 或增删其他工具时，只修改 OpenCode 配置，不需要改后端代码。
- 主 Agent 可通过 `list_agent_types` 查看当前工作区加载的 OpenCode Agent 类型，通过 `list_active_agents` 查看本团队可复用的存活 Worker；只有不存在合适实例时才使用 `spawn_workers`。
- Worker 持久记录所选 OpenCode Agent 名称，初次任务、后续追问和主子通信都会重复携带该名称，避免后续消息回落到默认 Build Agent。
- Worker 遇到业务问题时通过 `ask_main_agent` 询问主 Agent，主 Agent 通过 `answer_worker` 回答；主 Agent也可查询和主动指导 Worker。
- 低风险只读操作自动允许一次，明确的删除、强制 Git 和写数据库行为自动拒绝。
- 其他不确定权限直接交给专用权限审批 Agent，通过 `review_permission` 决定允许一次、拒绝或升级人工。
- 最终权限回复始终由后端 Permission Manager 发出；审批 Agent 永远不能授予 `always`。
- 页面权限中心展示静态规则、审批 Agent 和人工三轮判断的最近记录；待处理项支持“允许一次 / 本任务始终允许 / 拒绝”。
- 使用 Node.js 内置 SQLite 持久化 TaskGroup、Agent、WorkerTask、权限、审计和 Worker 幂等键。
- 启动时把本地 Agent 与 OpenCode Session 对账：存在的 Session 恢复，缺失的 Session 标记失败。
- 页面“最近任务”支持服务重启后重新进入原来的主 Agent 和 Worker。
- 页面采用三栏 Agent 工作台：任务与 Agent 切换、OpenCode 风格聊天、权限中心。
- 发送消息会立即乐观显示，并同时通过 OpenCode SSE 和 1.5 秒兜底轮询持续刷新。
- 聊天区支持 Markdown 标题、列表、代码块、表格和安全链接；工具调用可折叠，并支持“停止本轮”而不删除 Agent 或历史。
- `diff_review` 工具读取真实的修改前/修改后文件，生成 Diff 并阻塞等待页面确认，避免模型用文字描述改动产生偏差。
- 用户点击确定后，正在等待的工具调用直接返回 `ok`；提交、推送或部署仍由 Agent 自己决定和执行。
- 主 Agent 和 Worker 可通过 `watch_job` 登记持久化定时检查；工具立即返回，到期后后端向原 OpenCode Session 注入新消息并重新触发同一个 Agent。
- 未到期的 Watch Job 保存在 SQLite 中，Control Plane 重启后自动恢复；可用幂等键避免工具重试产生重复提醒。

默认数据库位于后端目录 `.data/opencode-control-plane.sqlite`，不放在团队工作空间中。

## 权限处理顺序

```text
OpenCode permission.asked
          ↓
静态规则：低风险自动允许 / 明确危险自动拒绝
          ↓ 其他不确定操作
专用审批 Agent：approve_once / reject / escalate
          ↓ 审批 Agent 升级或审批 Agent 自身越权
页面人工审批
          ↓
Permission Manager 回复 OpenCode
```

`always` 只能由人在页面或公开 API 中选择，主 Agent和审批 Agent都无法授予永久权限。

## 文件 Diff 人工确认

如果希望 Agent 自由完成编辑、最后通过真实 Diff 确认，应在对应 OpenCode Agent 的权限中开放目标目录和编辑工具，并允许 `diff_review`：

```markdown
---
description: 完成代码修改并提交整批人工审查
mode: primary
permission:
  "*": deny
  read: allow
  grep: allow
  glob: allow
  edit: allow
  bash: ask
  diff_review: allow
---

在允许的目录内完成编辑和验证。
准备提交前，调用 diff_review，传入真实的修改前文件和修改后文件。
只有工具返回 result=ok 才表示用户确认了当前 Diff。
提交和推送逻辑由你根据现有工具自行处理。
```

运行顺序：

```text
Agent 连续完成全部本地编辑
        ↓
diff_review(before_file, after_file)
        ↓ 后端读取两个真实文件并生成 Diff，工具调用保持等待
页面展示每个文件的新增与删除
        ↓ 点击“打开左右对比”，以 VS Code 风格按行号对齐显示修改前/修改后
        ├─ 拒绝 → 工具返回 rejected 和理由
        └─ 确定 → 工具返回 ok
                         ↓
              Agent 自行决定后续提交操作
```

`diff_review` 与编辑工具相互独立。它只负责对比、展示和返回人工决定，不保存发布授权，不拦截 `git push`，也不会替 Agent 提交代码。因为结果直接返回当前工具调用，所以不需要额外向 Agent Session 补发消息。

注意事项：

- 修改前、修改后文件都必须真实存在，并且路径相对于 `OPENCODE_DIRECTORY`。
- Agent 可以一次提交最多 30 组文件对比；单文件上限 1 MB，暂不支持二进制文件。
- 如果用户拒绝，Agent 修改后再次调用 `diff_review` 即可。

## 一次性 Task 与持久化 Watch Job

OpenCode 内置的 `task` 工具仍然可用。它适合边界明确、只需返回一次结果的临时调查；这类 Task SubAgent 的工具和权限应在对应 OpenCode Agent 定义中收紧，例如仅开放 `read`、`grep` 和 `glob`。它不会被登记为 Control Plane 中可反复对话的 Worker。

Control Plane Worker 则是独立且可复用的 Session，适合需要主 Agent 持续监工、后续追问或直接与用户对话的工作。主 Agent 不应使用 `task` 来替代这种 Worker。

`watch_job` 用于外部任务已经启动、但结果要稍后才能获取的场景：

```text
Agent 启动外部任务
        ↓
watch_job(delay_seconds, wake_message)
        ↓ 立即返回 scheduled，当前这轮结束
SQLite 保存提醒；Agent 和模型都不需要持续运行
        ↓ 时间到（服务重启也会恢复）
后端向原 Session 写入 wake_message 并触发执行
        ↓
同一个 Agent 查询外部任务的真实状态
        ├─ 已完成 → 读取结果并继续
        └─ 未完成 → 再调用 watch_job 安排下一次检查
```

Watch Job 只保证“到时唤醒并要求检查”，并不假设外部任务一定已经完成。最长单次延迟为 7 天；`idempotency_key` 可防止同一次工具调用重试时重复登记。

## 环境要求

- Node.js 24 或更高版本。当前开发环境是 Node.js 26。
- 一个已运行的 OpenCode Server。

启动 OpenCode：

```bash
OPENCODE_SERVER_PASSWORD=change-me \
CONTROL_PLANE_URL=http://127.0.0.1:4100 \
CONTROL_PLANE_TOOL_TOKEN=change-tool-token \
opencode serve --hostname 127.0.0.1 --port 4096
```

先确认 OpenCode 已经可以访问：

```bash
curl http://127.0.0.1:4096/global/health
```

没有设置密码时应返回类似 `{"healthy":true,"version":"1.17.15"}`。如果设置了密码，使用：

```bash
curl -u opencode:change-me http://127.0.0.1:4096/global/health
```

启动 Control Plane：

```bash
OPENCODE_BASE_URL=http://127.0.0.1:4096 \
OPENCODE_SERVER_PASSWORD=change-me \
CONTROL_PLANE_URL=http://127.0.0.1:4100 \
CONTROL_PLANE_TOOL_TOKEN=change-tool-token \
OPENCODE_DIRECTORY=/absolute/path/to/team-workspace \
CONTROL_PLANE_DATABASE_PATH=/absolute/path/to/control-plane.sqlite \
npm start
```

首次复制工作空间后安装 Custom Tool 依赖：

```bash
npm install --prefix /absolute/path/to/team-workspace/.opencode
```

模板当前固定使用 `ali/qwen3-coder-plus`，避免 OpenCode 在没有默认模型时回退到最近使用的免费模型。部署到其他 Provider 环境时，修改工作空间 `opencode.json` 的 `model`，或同时设置 `OPENCODE_PROVIDER_ID` 和 `OPENCODE_MODEL_ID` 覆盖。

默认监听 `http://127.0.0.1:4100`。

启动前也可以运行诊断：

```bash
npm run doctor
```

如果 OpenCode 不在 `4096` 端口，请同时给诊断和启动命令设置正确地址：

```bash
OPENCODE_BASE_URL=http://127.0.0.1:<实际端口> npm run doctor
OPENCODE_BASE_URL=http://127.0.0.1:<实际端口> npm start
```

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CONTROL_PLANE_HOST` | `127.0.0.1` | Control Plane 监听地址 |
| `CONTROL_PLANE_PORT` | `4100` | Control Plane 端口 |
| `OPENCODE_BASE_URL` | `http://127.0.0.1:4096` | OpenCode Server 地址 |
| `OPENCODE_DIRECTORY` | `<后端目录>/workspace-template` | 主 Agent 和所有 Worker 共享的团队 OpenCode 工作空间；生产环境建议显式设置绝对路径 |
| `OPENCODE_SERVER_USERNAME` | `opencode` | OpenCode Basic Auth 用户名 |
| `OPENCODE_SERVER_PASSWORD` | 无 | OpenCode Basic Auth 密码 |
| `OPENCODE_PROVIDER_ID` | OpenCode 默认值 | 覆盖主 Agent、Worker 和审批 Agent 使用的 Provider；必须与 Model ID 一起设置 |
| `OPENCODE_MODEL_ID` | OpenCode 默认值 | 与 Provider 配套的模型 ID |
| `CONTROL_PLANE_MAIN_AGENT` | `control-plane-main` | 创建团队时选择的 OpenCode 原生主 Agent 名称 |
| `CONTROL_PLANE_APPROVAL_AGENT` | `permission-approver` | 后端转发未知权限时选择的 OpenCode 原生审批 Agent 名称 |
| `CONTROL_PLANE_DEFAULT_WORKER_AGENT` | `control-plane-worker` | `spawn_workers` 未指定 `agent_name` 时使用的原生 Agent 名称 |
| `MAX_CONCURRENT_WORKERS` | `3` | 每个批次同时创建的 Worker 上限 |
| `CONTROL_PLANE_TOOL_TOKEN` | 无 | 保护 Agent 通信、Worker 创建和权限审核内部入口；OpenCode 与 Control Plane 必须一致 |
| `MAX_REQUEST_BYTES` | `1048576` | JSON 请求体上限 |
| `CONTROL_PLANE_DATABASE_PATH` | `<后端目录>/.data/opencode-control-plane.sqlite` | SQLite 数据库文件；测试可使用 `:memory:` |

## 定义可调度的 OpenCode Agent

Control Plane 不在前端创建 Agent。Agent 类型由 OpenCode 自己的配置系统管理，与内置的 Build Agent 使用同一套运行时定义。Build 是 OpenCode 内置的 `primary` Agent；你创建的是自定义 Agent。

团队工作空间模板已经在 [opencode.json](workspace-template/opencode.json) 中提供三个默认定义：

- `control-plane-main`：团队主 Agent，可使用编排、主从通信、Diff 审查和 Watch Job 工具。
- `permission-approver`：隐藏的审批 Agent，只能看到 `review_permission`。
- `control-plane-worker`：通用 Worker，可使用 `ask_main_agent`，看不到 `question` 和团队管理工具。

三个定义都带有一段简短的原生 `prompt`。OpenCode 会先注入该 Agent 的原生 prompt，再拼接 Control Plane 每轮发送的动态协作说明；两者都会进入最终模型请求的 system 内容。

你可以直接在工作空间 `opencode.json` 的 `agent` 字段增删改这些定义，也可以改用 OpenCode 的 Markdown Agent 文件。修改后让 OpenCode 重新加载配置；Control Plane 无需重新实现或维护一份工具白名单。

项目级 Agent 放在 Control Plane 所连接工作区的：

```text
<OPENCODE_DIRECTORY>/.opencode/agents/<agent-name>.md
```

用户级 Agent 可以放在：

```text
~/.config/opencode/agents/<agent-name>.md
```

例如 `.opencode/agents/sql-investigator.md`：

```markdown
---
description: 只读排查 SQL、数据口径和上下游依赖
mode: primary
permission:
  "*": deny
  read: allow
  grep: allow
  glob: allow
  list: allow
  bash: ask
  ask_main_agent: allow
---

排查数据问题；遇到业务口径、优先级或信息不足时调用 ask_main_agent 询问主 Agent。
```

文件名 `sql-investigator.md` 对应调用时的 Agent 名称 `sql-investigator`。`mode: primary` 会让它像 Build 一样成为可直接选择的主 Agent；也可以使用 `subagent` 或 `all`。Control Plane 创建的 Worker 始终是独立 Session，因此不会使用 OpenCode 内置的一次性 Task subagent 作为 Worker 实例。

Markdown 正文是该 Agent 的专用系统提示词，但不是必填项。只配置 `description`、`mode` 和 `permission` 也可以正常工作；不过建议至少填写清晰的 `description`，这样主 Agent 才能正确选择类型。涉及角色边界、何时询问主 Agent等行为时，也建议写正文提示词。

`permission` 同时决定工具可见性和执行方式：

- 完全 `deny` 的工具不会发送给模型。
- `ask` 的工具对模型可见，调用后进入 Control Plane 权限审批流程。
- `allow` 的工具对模型可见并由 OpenCode 直接执行。

注意：`"*": "ask"` 不是“只开放后面列出的工具”，而是“所有未单独覆盖的工具都可见，调用时询问”。因此当前主 Agent 和通用 Worker 保留正常 OpenCode 工具；审批 Agent 使用 `"*": "deny"`，所以实际上只看得到单独允许的 `review_permission`。

不要再使用旧的布尔 `tools` 配置；OpenCode 1.17.15 仍兼容它，但官方已推荐改用 `permission`。

Control Plane 调用 OpenCode 时，与 Agent 选择和工具权限相关的关键字段是：

```json
{
  "agent": "sql-investigator",
  "parts": [{ "type": "text", "text": "检查广告费" }]
}
```

后端还会发送用户文本、模型和 Control Plane 的动态协作说明，但不会再发送 `tools`，创建 Session 时也不会附加 `permission`。因此 OpenCode 最终给模型暴露哪些工具、哪些调用直接允许、拒绝或发出 `ask`，都以所选命名 Agent 的配置为准。Control Plane 只在 OpenCode 已经产生 `ask` 事件之后负责静态过滤、审批 Agent 路由、人工接管和最终回复。

主 Agent 调度顺序固定为：

```text
list_agent_types
        ↓
list_active_agents
        ↓
有合适实例 → message_worker 继续原 Session
没有实例   → spawn_workers，并为每个任务指定 agent_name
```

`spawn_workers` 每次创建的是新实例；`message_worker` 才会复用原 Worker 的 Session、上下文和 Agent 类型。后端会校验 `agent_name` 必须存在于 OpenCode 当前加载且非隐藏的 Agent 列表中。

## API

```text
GET  /health
POST /api/task-groups
GET  /api/task-groups
GET  /api/task-groups/:id
POST /api/task-groups/:id/workers
POST /api/agents/:id/messages
GET  /api/agents/:id/messages
POST /api/agents/:id/abort
GET  /api/job-watches
POST /api/job-watches/:id/cancel
GET  /api/events
GET  /api/permissions
POST /api/permissions/:id/decision
GET  /api/change-reviews
POST /api/change-reviews/:id/decision
GET  /api/agent-questions
GET  /api/audit
POST /internal/orchestrator/spawn-workers
POST /internal/orchestrator/list-agent-types
POST /internal/orchestrator/list-active-agents
POST /internal/orchestrator/diff-review
POST /internal/orchestrator/watch-job
POST /internal/orchestrator/ask-main
POST /internal/orchestrator/answer-worker
POST /internal/orchestrator/list-workers
POST /internal/orchestrator/message-worker
POST /internal/orchestrator/permission-reviews
```

创建 Agent Team：

```bash
curl -X POST http://127.0.0.1:4100/api/task-groups \
  -H 'content-type: application/json' \
  -d '{"title":"商品损益排查"}'
```

发送消息：

```bash
curl -X POST http://127.0.0.1:4100/api/agents/<agent-id>/messages \
  -H 'content-type: application/json' \
  -d '{"text":"检查钉钉文档里的费用项"}'
```

监听事件：

```bash
curl -N http://127.0.0.1:4100/api/events
```

查看待审批权限并允许一次：

```bash
curl 'http://127.0.0.1:4100/api/permissions?status=PENDING'

curl -X POST http://127.0.0.1:4100/api/permissions/<permission-id>/decision \
  -H 'content-type: application/json' \
  -d '{"decision":"once","rationale":"人工确认只读查询"}'
```

页面只负责创建 Agent Team 和对话。用户把完整任务交给主 Agent；主 Agent先通过工作空间里的 `.opencode/tools/list_agent_types.ts` 和 `list_active_agents.ts` 了解可用类型与现有实例，再决定复用 Worker 或通过 `spawn_workers.ts` 创建独立 Worker Session。Worker 通过 `ask_main_agent.ts` 向主 Agent 求助；权限请求由后端直接发给隐藏的权限审批 Agent，并由 `review_permission.ts` 返回结构化决定。

`watch_job.ts` 会把当前 Custom Tool 上下文里的 Session ID 连同延迟和唤醒消息登记到后端。它不会在工具调用中等待；到期后后端使用 OpenCode 的异步消息接口唤醒原 Session。公开接口 `GET /api/job-watches?task_group_id=<id>` 可查看记录，`POST /api/job-watches/<id>/cancel` 可取消尚未触发的记录。

## 验证

测试覆盖目录路由、完整团队流程、OpenCode HTTP、Fetch、SSE、SQLite 关闭重开、Worker 幂等键、Session 恢复和 Watch Job 重启恢复，不需要真实模型或账号：

```bash
npm test
```

还可以让本机 OpenCode 自己解析每个 Agent，核对原生 prompt、最终可见工具和 deny 是否生效：

```bash
npm run verify:agents
```

验证分两层：测试会截获 Control Plane 的 OpenCode 请求并确认其中没有 `tools`/`permission` 覆盖；`verify:agents` 再确认 OpenCode 按 `agent` 名称解析出的实际工具集合。不要把“询问模型它有哪些工具”的回答当成权限证据，模型自述只适合辅助冒烟检查。

完整测试矩阵见 [验证说明](docs/verification.md)。后端早期设计记录仍保留在 [outputs/opencode-control-plane-backend-design.md](outputs/opencode-control-plane-backend-design.md)，当前实现与部署方式以 `docs/` 和本 README 为准。
