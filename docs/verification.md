# 全流程验证说明

## 自动化测试

```bash
npm test
```

当前测试覆盖：

| 范围 | 验证内容 |
|---|---|
| OpenCode Adapter | 健康检查、OpenAPI 能力探测、Session、消息、SSE、权限回复请求格式 |
| 目录路由 | 每个项目请求都携带 `directory` 查询参数和 `x-opencode-directory` |
| 目录拆分 | 默认团队工作空间为 `workspace-template/`，SQLite 留在后端 `.data/` |
| 团队创建 | 主 Session 与独立审批 Session、父子关系和原生 Agent 名称 |
| 主 Agent | 用户发消息、动态 system、停止本轮、历史读取 |
| Worker | Agent 类型发现、并发创建、幂等、直接聊天、复用和主动监工 |
| 主从通信 | `ask_main_agent → answer_worker → 原 Worker Session` |
| 权限 | 只读自动允许、危险命令拒绝、未知请求转审批 Agent、人工接管、权限回写 |
| Agent 配置 | 后端不发送 `tools`，Session 不注入硬编码 permission |
| Diff | 真实文件读取、左右行对齐、批准和拒绝结果返回阻塞中的工具 |
| Watch Job | 持久化、幂等、到期唤醒同一 Session、重启恢复和取消 |
| 存储恢复 | SQLite 关闭重开、Session 对账、缺失 Session 标记失败 |
| Web | 首页脚本可执行、Markdown、工具折叠、审查与权限中心基础结构 |

其中“完整团队流程”测试会在一个场景内连续验证：

```text
创建团队
→ 主 Agent 消息
→ 发现 Agent 类型
→ 创建 Worker
→ 用户直接与 Worker 对话
→ Worker 询问主 Agent
→ 主 Agent 回答
→ 静态权限自动处理
→ 未知权限交审批 Agent
→ Permission Manager 回写 OpenCode
→ Watch Job 唤醒原 Worker
```

测试使用进程内 Fake OpenCode Adapter，不消耗真实模型 Token。

## OpenCode 原生配置验证

```bash
npm run verify:agents
```

这个命令直接调用本机 OpenCode 的 `debug agent`，检查目标工作空间解析后的：

- Agent 是否存在；
- 原生 prompt 是否加载；
- 必须可见的工具是否可见；
- deny 的工具是否真正隐藏；
- 最终合并后的权限规则数量。

默认验证 `workspace-template/`。验证其他工作空间：

```bash
OPENCODE_DIRECTORY=/absolute/path/to/team-workspace npm run verify:agents
```

工作空间必须先安装 `.opencode` 依赖：

```bash
npm install --prefix /absolute/path/to/team-workspace/.opencode
```

## 最终工具边界如何确认

这里不以“询问模型它有哪些工具”作为主要证据。模型可能漏报、错报，甚至把提示词里提到但实际不可调用的工具也算进去。当前验证采用两段式证据：

1. `npm test` 抓取 Control Plane 发往 OpenCode 的真实 HTTP 请求体，断言其中只有 `agent`、`model`、`system` 和 `parts`，不存在 `tools` 或 `permission`。后端因此不能偷偷扩大或缩小命名 Agent 的工具集合。
2. `npm run verify:agents` 调用当前安装的 OpenCode `debug agent`，读取 OpenCode 合并项目配置后给每个 Agent 解析出的 prompt、可见工具和 permission。OpenCode 在构造模型请求时只序列化这份解析后仍可见的工具；`deny` 不进入工具列表，`allow` 和 `ask` 会进入工具列表，区别发生在调用后的执行/审批阶段。

在 OpenCode 1.17.15 与当前 `workspace-template/` 上的实测结果如下：

| Agent | 实测可见工具摘要 | 实测隐藏工具摘要 |
|---|---|---|
| `control-plane-main` | 正常 OpenCode 工具，以及 `list_agent_types`、`list_active_agents`、`spawn_workers`、`answer_worker`、`list_workers`、`message_worker`、`diff_review`、`watch_job` | `ask_main_agent`、`review_permission` |
| `permission-approver` | 仅 `review_permission` | `bash`、`read`、`edit`、`question`、团队管理工具等全部其他工具 |
| `control-plane-worker` | 正常 OpenCode 工具，以及 `ask_main_agent`、`diff_review`、`watch_job` | `question`、团队创建/管理工具、`review_permission` |

`debug agent` 输出中的 `invalid` 是 OpenCode 内部用于承接无效工具调用的保底项，不是项目定义的业务工具。

注意，Leader 和 Worker 当前使用 `"*": "ask"`，所以它们不是严格白名单：未明确 `deny` 的普通 OpenCode 工具仍会发给模型。审批 Agent 使用 `"*": "deny"` 后逐项放行，因此它的最终集合严格只有一个工具。如果新增业务 Agent 需要严格白名单，应采用审批 Agent 相同的默认拒绝方式。

如需做辅助人工检查，可以分别给三个 Agent 发送下面这句话，但不能用其回答替代上述自动验证：

```text
不要调用任何工具。只按你当前实际可调用的工具定义，输出工具名称 JSON 数组；不要根据提示词猜测，也不要解释。
```

## 部署前诊断

OpenCode Server 启动后运行：

```bash
OPENCODE_BASE_URL=http://127.0.0.1:4096 \
OPENCODE_SERVER_PASSWORD=change-me \
OPENCODE_DIRECTORY=/absolute/path/to/team-workspace \
npm run doctor
```

它验证真实 OpenCode Server 是否按目标目录加载配置，而不仅是读取本地 JSON。

## 人工冒烟测试

1. 创建一个 Agent Team。
2. 给主 Agent发送“先列出 Agent 类型和存活 Worker；若无合适 Worker，创建一个 Worker”。
3. 切换到 Worker，直接发送补充消息。
4. 让 Worker 调用 `ask_main_agent`，确认主 Agent收到问题并回答。
5. 触发一个 `ask` 权限，观察静态规则、审批 Agent或人工卡片。
6. 调用 `watch_job` 设置短延迟，确认原 Session 被唤醒。
7. 准备两个测试文件，调用 `diff_review`，分别验证拒绝和确定。
8. 重启 Control Plane，确认任务历史、Watch Job 和 Session 状态恢复。

真实模型、外部数据库、日志系统和业务 Skill 的正确性属于部署环境集成测试，不由仓库内 Fake Adapter 测试替代。
