# 里程碑 E：主从 Agent 通信与专用权限审批 Agent

## 当前角色

- `MAIN`：接收用户任务、创建 Worker、查询 Worker 状态、主动下发指导、回答 Worker 问题。
- `WORKER`：完整独立的 OpenCode Session，可以由用户直接聊天并使用常规工具；禁用内置 `question`，改用 `ask_main_agent` 向主 Agent 求助。
- `APPROVER`：每个 TaskGroup 自动创建一个独立审批 Session，只负责处理后端转发的权限审核。

## 已完成链路

### Worker 与主 Agent

1. Worker 调用 `ask_main_agent`。
2. 后端校验调用者确实是该任务组的 Worker，创建并持久化 `AgentQuestion`。
3. 后端把问题和 Question ID 发送给主 Agent Session。
4. 主 Agent 调用 `answer_worker`。
5. 后端校验主从归属，记录回答，并把回答作为新消息发送回原 Worker Session。
6. Worker 使用主 Agent 的指导继续工作。

主 Agent 还可以调用：

- `list_workers`：查看 Worker、任务状态和待回答问题。
- `message_worker`：主动向指定 Worker 发送监工指令。

### 权限审批

1. 后端收到 OpenCode permission ask 事件。
2. 静态规则先处理：
   - 读取、搜索、目录浏览和只读命令自动允许一次。
   - 删除、强制 Git 和写数据库操作自动拒绝。
3. 其他不确定请求由后端直接发送给该 TaskGroup 的 `APPROVER` Session，不经过主 Agent。
4. 审批 Agent 调用 `review_permission`，选择 `approve_once / reject / escalate`。
5. Permission Manager 才是唯一真正回复 OpenCode permission API 的组件。
6. `escalate` 留在页面权限中心等待用户；`always` 只能由用户选择。

审批 Agent 的普通项目工具被禁用，Session 权限规则为默认拒绝、仅允许 `review_permission`。如果审批 Agent 自己产生额外权限请求，系统不会递归自审，而是直接等待人工。

## 页面变化

- 创建 TaskGroup 时立即显示主 Agent 和权限审批 Agent。
- Agent 列表可切换主 Agent、任意 Worker 和权限审批 Agent 的独立聊天记录。
- 主 Agent 有待回复的 Worker 问题时，列表显示待回复数量。
- 权限中心会显示“权限审批 Agent 正在审核”，用户仍能随时接管。

## 数据与接口

- SQLite 新增 `agent_questions`，问题和回答支持重启恢复。
- 新增 `GET /api/agent-questions`。
- 新增内部入口：`ask-main`、`answer-worker`、`list-workers`、`message-worker`、`permission-reviews`。
- 移除旧的 `recommend_permission` 工具和“主 Agent 审批建议”入口。
- 老数据库里的 `MAIN_AGENT` 决策来源和 `recommendationRequested` 字段仅保留读取兼容，不再产生新记录。

## 验证

- 14 项自动化测试全部通过。
- 覆盖主/审批 Session 自动创建、Worker 工具配置、Worker 问答往返、主 Agent 主动监工、审批 Agent 路由、静态权限过滤、人工升级、SQLite 持久化和重启恢复。
- 所有自定义工具文件均通过 Node 语法检查。

## 下一步建议

下一阶段接真实业务入口：钉钉文档读取、费用字段提取、字段任务模板和现有商品损益 Skill 注入。编排、主从通信和审批层现在已经可以作为稳定底座。
