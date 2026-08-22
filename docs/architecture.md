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
2. 在数据库登记只读的逻辑审批 Agent，用于页面展示聚合后的审批时间线，不长期占用一个 OpenCode Session；
3. 主 Agent需要 Worker 时调用 `spawn_workers`；
4. 后端为每项任务创建独立 Session，`parentID` 指向主 Session；
5. 遇到未知权限时，为该权限新建临时审批 Session，`parentID` 指向主 Session，Agent 名称为 `permission-approver`；
6. 后续给主 Agent 或 Worker 发消息时，继续携带该实例保存的 Agent 名称。

主从关系主要保存在 Control Plane 数据库中。OpenCode 的 `parentID` 用于补充 Session 层级，但不会替代后端的任务、角色和权限路由数据。

主 Agent 和默认 Worker 使用白名单式权限：默认 `* : deny`，再逐项开放正常工作需要的工具，并明确设置 `permission.task: deny`。这种顺序符合 OpenCode“最后命中规则生效”的规则，可让原生 Task 真正从模型工具上下文中消失；配置中还保留 `tools.task: false` 以兼容新配置语义。所有团队 Worker 都由 `spawn_workers` 创建为可在页面查看和继续对话的独立 Session。`spawn_workers.tasks` 是真正的对象数组，不接受装有 JSON 的字符串。

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
| 主 Agent | `"*": "ask"`，常见只读工具 `allow` | 保留正常 OpenCode 工具；读取和团队编排工具直接允许，禁止 Worker/审批专用工具 |
| 审批 Agent | `"*": "deny"` | 只看得到 `review_permission` |
| Worker | `"*": "ask"`，常见只读工具 `allow` | 保留正常工具；读取、`ask_main_agent`、Diff、Watch 直接允许，隐藏直接问用户和团队管理工具 |

`"*": "ask"` 不是白名单。它表示所有没有被后续规则覆盖的工具仍然可见，但调用时需要审批。若某个业务 Worker 必须是严格只读白名单，应使用 `"*": "deny"`，再逐项 `allow`。

这条边界在两个位置做自动验证：Adapter 请求测试确认 Control Plane 不发送 `tools`/`permission` 覆盖项；`npm run verify:agents` 确认 OpenCode 选择命名 Agent 后的最终 prompt 和可见工具集合。模型自述工具列表不作为权限证据。

## 7. 权限审批链路

```text
Agent 调用 `allow` 工具 → OpenCode 直接执行，Control Plane 不会收到事件或产生记录

Agent 调用 `ask` 工具
        ↓
OpenCode 暂停工具并发出 permission.asked
        ↓
Permission Manager 幂等落库
        ↓
静态规则
  ├─ 明确只读 → allow once
  ├─ 明确危险 → reject
  └─ 无法判断 → 为本请求新建一次性审批 Agent Session
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

审批 Agent只给结构化建议。每次审批都使用新的 OpenCode Session，并带入来源 Agent、Worker 任务、最近用户意图、工作空间、命令、元数据、风险和审批原则快照，因此不会受前一条审批历史或未来上下文压缩影响。任务与消息内容被标记为不可信背景数据并限制长度。页面中的审批 Agent 是后端从权限记录生成的聚合时间线。审批 Agent 没有 OpenCode 权限回复凭证，不能授予 `always`；真正回复 OpenCode 的始终是后端 Permission Manager。

每条权限只接受审批 Agent 的第一个有效 `review_permission` 回调。结果入库后，重复回调被记录并忽略，临时审批 Session 在响应返回后中止并删除。`escalate` 不会回复原 OpenCode 权限，而是把记录明确切换为“待人工”并保留升级原因。

每个 TaskGroup 保存一份 `approvalPolicy`。新团队使用保守默认值；主 Agent 可通过 `set_approval_policy` 根据用户要求更新。Permission Manager 在把未知权限发送给审批 Agent 时会附上当前策略。静态硬拒绝优先于动态策略，因此主 Agent 不能通过策略放开删除、强制 Git 或写数据库等明确危险行为。

`external_directory` 的固定路径白名单属于 OpenCode 原生 `permission` 配置。允许跨目录边界后，具体读取、编辑或命令操作仍分别经过 `read`、`edit`、`bash` 等规则；如果只允许读取外部资料，应同时为该路径拒绝编辑并限制命令。Control Plane 只处理 OpenCode 仍然发出的 `ask`，不覆盖工作空间配置已经明确允许或拒绝的路径。

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

同理，`message_worker`、`spawn_workers`、`set_approval_policy`、`review_permission`、`diff_review` 和 `watch_job` 都是 OpenCode Custom Tool 到 Control Plane API 的桥接。

## 9. Diff、Watch Job 与持久化

- `diff_review`：OpenCode Agent 配置直接允许调用，后端从 `OPENCODE_DIRECTORY` 读取真实文件，先生成文件行级 Diff，再为配对的修改行计算字符级行内差异片段；页面用浅色整行背景和深色片段高亮展示左右对比。超长或相似度过低的行会安全退化为整行高亮。工具在独立的人工作业闸门中阻塞等待用户确认；它不经过普通权限审批 Agent，也不负责提交或推送。
- `watch_job`：把 Session ID、唤醒时间和消息写入 SQLite，到期后给同一个 Session 发送新消息；服务重启后恢复。
- SQLite：属于后端状态，不属于团队工作空间；默认保存在后端目录 `.data/`。
- OpenCode Session 历史：由 OpenCode Server 保存；后端只保存映射、状态、审批、审计和业务索引。

OpenCode 的异步 Prompt 会在 Session 忙碌时进入同一 Session 的执行队列。若 Worker 正在等待一个权限结果，主 Agent 监督消息或 Watch Job 到期消息不会直接拼接到 provider 的未完成 tool call 后；OpenCode 先等待当前运行恢复和收尾，再执行排队 Prompt。因此 provider 所要求的 `tool call → tool result` 顺序由 OpenCode Runtime 保持，Control Plane 不自行拼装原始消息数组。

删除 TaskGroup 时，后端先取消未触发的 Watch Job、结束待处理 Diff、尽力拒绝待审批权限，再中止并删除主 Agent、Worker 和临时审批 Session，最后清理 SQLite 中该团队的业务记录。

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
