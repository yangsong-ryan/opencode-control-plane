# OpenCode Control Plane

这是 OpenCode Agent 管理项目的里程碑 E：一个零依赖、可运行、可重启恢复的多 Session Control Plane。

当前能力：

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
- 创建 Session 时注入 Control Plane 权限规则，让 OpenCode 的工具请求进入统一审批链路。
- 同时兼容 OpenCode 1.17.15 的传统权限接口和 V2 权限事件。
- 主 Agent 与 Worker 都保留正常 OpenCode 工具能力；Worker 仅禁用直接询问用户的 `question` 工具。
- Worker 遇到业务问题时通过 `ask_main_agent` 询问主 Agent，主 Agent 通过 `answer_worker` 回答；主 Agent也可查询和主动指导 Worker。
- 低风险只读操作自动允许一次，明确的删除、强制 Git 和写数据库行为自动拒绝。
- 其他不确定权限直接交给专用权限审批 Agent，通过 `review_permission` 决定允许一次、拒绝或升级人工。
- 最终权限回复始终由后端 Permission Manager 发出；审批 Agent 永远不能授予 `always`。
- 页面权限中心支持“允许一次 / 本任务始终允许 / 拒绝”，并持久保存审计记录。
- 使用 Node.js 内置 SQLite 持久化 TaskGroup、Agent、WorkerTask、权限、审计和 Worker 幂等键。
- 启动时把本地 Agent 与 OpenCode Session 对账：存在的 Session 恢复，缺失的 Session 标记失败。
- 页面“最近任务”支持服务重启后重新进入原来的主 Agent 和 Worker。
- 页面采用三栏 Agent 工作台：任务与 Agent 切换、OpenCode 风格聊天、权限中心。
- 发送消息会立即乐观显示，并同时通过 OpenCode SSE 和 1.5 秒兜底轮询持续刷新。
- 聊天区展示文本、思考过程、工具调用状态与输出、模型错误，并支持停止当前 Agent。

默认数据库位于工作区 `.data/opencode-control-plane.sqlite`，该目录已加入 `.gitignore`。

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

## 环境要求

- Node.js 24 或更高版本。当前开发环境是 Node.js 26。
- 一个已运行的 OpenCode Server。

启动 OpenCode：

```bash
OPENCODE_SERVER_PASSWORD=change-me \
CONTROL_PLANE_TOOL_TOKEN=local-tool-secret \
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
CONTROL_PLANE_TOOL_TOKEN=local-tool-secret \
OPENCODE_PROVIDER_ID=ali \
OPENCODE_MODEL_ID=qwen3-coder-plus \
OPENCODE_DIRECTORY=/absolute/path/to/project \
CONTROL_PLANE_DATABASE_PATH=/absolute/path/to/control-plane.sqlite \
npm start
```

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
| `OPENCODE_DIRECTORY` | 当前目录 | OpenCode 工作区 |
| `OPENCODE_SERVER_USERNAME` | `opencode` | OpenCode Basic Auth 用户名 |
| `OPENCODE_SERVER_PASSWORD` | 无 | OpenCode Basic Auth 密码 |
| `OPENCODE_PROVIDER_ID` | 项目 `opencode.json` | 指定主 Agent、Worker 和审批 Agent 使用的 Provider |
| `OPENCODE_MODEL_ID` | 项目 `opencode.json` | 与 Provider 配套的模型 ID；本项目默认 `qwen3-coder-plus` |
| `MAX_CONCURRENT_WORKERS` | `3` | 每个批次同时创建的 Worker 上限 |
| `CONTROL_PLANE_TOOL_TOKEN` | 无 | 保护 Agent 通信、Worker 创建和权限审核内部入口；OpenCode 与 Control Plane 必须一致 |
| `MAX_REQUEST_BYTES` | `1048576` | JSON 请求体上限 |
| `CONTROL_PLANE_DATABASE_PATH` | `<OPENCODE_DIRECTORY>/.data/opencode-control-plane.sqlite` | SQLite 数据库文件；测试可使用 `:memory:` |

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
GET  /api/events
GET  /api/permissions
POST /api/permissions/:id/decision
GET  /api/agent-questions
GET  /api/audit
POST /internal/orchestrator/spawn-workers
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

页面只负责创建 Agent Team 和对话。用户把完整任务交给主 Agent；主 Agent 自行决定是否创建 Worker、创建几个以及如何分工，并通过 `.opencode/tools/spawn_workers.ts` 创建独立 Worker Session。Worker 通过 `ask_main_agent.ts` 向主 Agent 求助；权限请求由后端直接发给隐藏的权限审批 Agent，并由 `review_permission.ts` 返回结构化决定。

## 验证

测试覆盖 OpenCode HTTP、Fetch、SSE、SQLite 关闭重开、Worker 幂等键和 Session 恢复，不需要真实模型或账号：

```bash
npm test
```

后端详细设计见 [outputs/opencode-control-plane-backend-design.md](outputs/opencode-control-plane-backend-design.md)。
