# OpenCode Control Plane：功能与底层实现原理

## 1. 系统由两部分组成

```text
Control Plane 后端目录                 团队 OpenCode 工作空间
─────────────────────                 ─────────────────────
src/                                  opencode.json
package.json                          .opencode/tools/
scripts/                              .opencode/agents/（可选）
.data/                                .opencode/skills/（可选）
                                      业务代码、脚本、文档和数据
           │                                      │
           └──── HTTP / Session 编排 ─────────────┘
                              OpenCode Server
```

Control Plane 后端负责：

- TaskGroup、主 Agent、Worker 和审批 Agent 的逻辑关系；
- 创建、复用、中止和恢复 OpenCode Session；
- 主从 Agent 消息路由；
- 权限 ask 事件的静态过滤、审批 Agent 路由和人工接管；
- Diff 人工确认、Watch Job、审计、SQLite 持久化和 Web 页面。

团队工作空间负责：

- OpenCode 原生 Agent 定义、提示词和 `permission`；
- 项目级 Custom Tool、Skill、AGENTS.md；
- Agent 真正读取、搜索、编辑和执行命令的业务文件；
- 业务项目自己的 Git 仓库和依赖。

Control Plane 不重新实现 OpenCode 的模型上下文、工具运行时和项目配置系统。

## 2. 工作目录是怎样确定的

当前版本在启动时读取一个绝对路径：

```text
OPENCODE_DIRECTORY=/srv/opencode-team-workspace
```

`OpenCodeAdapter` 保存这个路径。对所有项目相关请求，它同时发送：

```http
POST /session/<id>/prompt_async?directory=/srv/opencode-team-workspace
x-opencode-directory: %2Fsrv%2Fopencode-team-workspace
```

OpenCode Server 的目录解析顺序是：

1. 请求的 `directory` 查询参数；
2. `x-opencode-directory` 请求头；
3. OpenCode Server 进程自己的当前目录。

因此，OpenCode Server 从哪里启动并不决定本系统的 Agent 工作目录。真正决定目录的是 Control Plane 每次请求携带的 `OPENCODE_DIRECTORY`。

创建 Session 时，这个目录用于选择 OpenCode 项目实例并写入 Session 上下文。后续消息仍由同一个 Session 和相同目录处理。主 Agent、审批 Agent和所有 Worker 都通过同一个 Adapter 创建，所以当前一个 Control Plane 进程中的所有团队共享同一个工作空间。

## 3. OpenCode 如何加载这个目录中的配置

收到带目录的请求后，OpenCode 会从该目录开始，向上查找到当前 Git worktree 根目录，合并项目配置：

- `opencode.json` 或 `opencode.jsonc`；
- `.opencode/agents/*.md`；
- `.opencode/tools/*.ts`；
- `.opencode/skills/*/SKILL.md`；
- `AGENTS.md`；
- 用户级 `~/.config/opencode/` 配置。

离工作目录更近的项目配置优先级更高。模板目前把三个核心 Agent 直接写在工作空间的 `opencode.json` 中；额外业务 Agent 可以继续写在 JSON 中，也可以使用 `.opencode/agents/*.md`。

正确文件名是 `opencode.json`，不是 `.opencode.json`。

## 4. Agent 与 Session 的关系

OpenCode Agent 是一种可复用配置类型，例如：

```text
control-plane-main
permission-approver
control-plane-worker
sql-investigator
```

OpenCode Session 是一次可持续对话的运行实例。多个 Session 可以选择同一个 Agent 类型，但聊天上下文彼此独立。

```text
Agent 类型：control-plane-worker
        │
        ├── Session A：广告费调查
        ├── Session B：履约费调查
        └── Session C：仓储费调查
```

Control Plane 创建一个团队时：

1. 创建主 Session，数据库记录其 Agent 名称为 `control-plane-main`；
2. 创建审批 Session，`parentID` 指向主 Session，Agent 名称为 `permission-approver`；
3. 主 Agent需要 Worker 时调用 `spawn_workers`；
4. 后端为每项任务创建独立 Session，`parentID` 指向主 Session；
5. 后续给任何 Session 发消息时，继续携带该实例保存的 Agent 名称。

主从关系主要保存在 Control Plane 数据库中。OpenCode 的 `parentID` 用于补充 Session 层级，但不会替代后端的任务、角色和权限路由数据。

## 5. 消息发送和提示词

Control Plane 发给 OpenCode 的消息请求包含：

```json
{
  "agent": "control-plane-worker",
  "model": {
    "providerID": "provider",
    "modelID": "model"
  },
  "system": "本轮 Control Plane 动态协作说明",
  "parts": [
    { "type": "text", "text": "本轮用户或主 Agent 消息" }
  ]
}
```

它不发送 Prompt 级 `tools`，创建 Session 时也不注入后端权限规则。OpenCode 根据 `agent` 名称读取工作空间中的原生 Agent 配置。

最终模型 system 内容按以下顺序组合：

```text
Agent 原生 prompt
+ Control Plane 动态 system
+ OpenCode 项目/用户说明
```

原生 prompt 适合稳定角色定义；动态 system 适合当前团队关系、Worker 问题 ID、权限请求 ID、Watch Job 唤醒原因等运行时信息。

## 6. 工具可见性与权限

OpenCode 原生 `permission` 决定工具行为：

- `deny`：工具不发送给模型；
- `allow`：工具可见并直接执行；
- `ask`：工具可见，模型调用后暂停并产生权限请求。

当前模板：

| Agent | 默认策略 | 关键结果 |
|---|---|---|
| 主 Agent | `"*": "ask"` | 保留正常 OpenCode 工具，团队编排工具直接允许，禁止 Worker/审批专用工具 |
| 审批 Agent | `"*": "deny"` | 只看得到 `review_permission` |
| Worker | `"*": "ask"` | 保留正常工具，允许 `ask_main_agent`、Diff、Watch，隐藏直接问用户和团队管理工具 |

`"*": "ask"` 不是白名单。它表示所有没有被后续规则覆盖的工具仍然可见，但调用时需要审批。若某个业务 Worker 必须是严格只读白名单，应使用 `"*": "deny"`，再逐项 `allow`。

这条边界在两个位置做自动验证：Adapter 请求测试确认 Control Plane 不发送 `tools`/`permission` 覆盖项；`npm run verify:agents` 确认 OpenCode 选择命名 Agent 后的最终 prompt 和可见工具集合。模型自述工具列表不作为权限证据。

## 7. 权限审批链路

```text
Worker 调用 ask 工具
        ↓
OpenCode 暂停工具并发出 permission.asked
        ↓
Permission Manager 幂等落库
        ↓
静态规则
  ├─ 明确只读 → allow once
  ├─ 明确危险 → reject
  └─ 无法判断 → 审批 Agent Session
                         ↓
              review_permission
               ├─ approve_once
               ├─ reject
               └─ escalate → Web 人工
        ↓
Permission Manager 调用 OpenCode 权限回复 API
        ↓
原 Worker 工具继续或终止
```

审批 Agent只给结构化建议。它没有 OpenCode 权限回复凭证，不能授予 `always`。真正回复 OpenCode 的始终是后端 Permission Manager。

## 8. 主 Agent 与 Worker 通信

Custom Tool 运行在 OpenCode Server 进程中，并能从 `ToolContext` 获得当前 `sessionID`。工具调用 Control Plane 内部 API 时会发送这个 ID：

```text
Worker Session
  └─ ask_main_agent(sessionID, question)
          ↓
Control Plane 查找所属 TaskGroup 与主 Session
          ↓
向主 Session 发送问题和 Question ID
          ↓
主 Agent 调用 answer_worker(Question ID, answer)
          ↓
Control Plane 向原 Worker Session 发送回答
```

同理，`message_worker`、`spawn_workers`、`review_permission`、`diff_review` 和 `watch_job` 都是 OpenCode Custom Tool 到 Control Plane API 的桥接。

## 9. Diff、Watch Job 与持久化

- `diff_review`：后端从 `OPENCODE_DIRECTORY` 读取真实文件，生成左右 Diff，并阻塞工具调用等待用户确认；它不负责提交或推送。
- `watch_job`：把 Session ID、唤醒时间和消息写入 SQLite，到期后给同一个 Session 发送新消息；服务重启后恢复。
- SQLite：属于后端状态，不属于团队工作空间；默认保存在后端目录 `.data/`。
- OpenCode Session 历史：由 OpenCode Server 保存；后端只保存映射、状态、审批、审计和业务索引。

## 10. 当前目录模型的边界

当前版本是：

```text
一个 Control Plane 进程 → 一个 OPENCODE_DIRECTORY → 多个 TaskGroup
```

所以不同 TaskGroup 的 Session 上下文独立，但文件系统工作空间相同。读任务通常可以并行；如果多个 Worker 同时改同一批文件，仍可能产生文件冲突。

如果未来需要一个后端同时管理多个工作空间，需要把 `workspace_id/directory` 加入 TaskGroup，并按工作空间创建 Adapter、权限上下文、Diff 根目录和 Session 恢复索引。当前实现尚未开放这个能力。

如果 OpenCode Server 与 Control Plane 分别运行在不同容器或机器上，两边必须能以同一个绝对路径访问团队工作空间，因为：

- OpenCode 在该路径运行工具；
- Control Plane 的 Diff Manager 在该路径读取文件。

容器部署时应把同一目录挂载到两个容器中的相同路径。Custom Tool 使用的 `CONTROL_PLANE_URL` 也必须是 OpenCode Server 能访问的地址，不能盲目使用容器自己的 `127.0.0.1`。
