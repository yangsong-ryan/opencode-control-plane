# 里程碑 C：Permission Manager 与权限中心

## 已完成

- OpenCode Session 创建时写入权限规则，工具权限由 Control Plane 统一接管。
- 监听并兼容 `permission.asked`、`permission.replied`、`permission.v2.asked` 和 `permission.v2.replied`。
- 启动时同步 OpenCode 已存在的待审批请求，避免服务重连后漏单。
- 建立 PermissionRequest 与 AuditRecord 内存模型，并把 Agent 状态切换为 `WAITING_APPROVAL`。
- 静态策略：
  - Worker 的只读文件操作和白名单只读命令自动允许一次。
  - 删除、强制 Git 操作、写数据库和 Worker 文件修改自动拒绝。
  - 外部目录、网络访问和未知高风险命令等待人工。
- 主 Agent 建议链路：
  - 未知但非高风险的 Worker 权限会发送给主 Agent。
  - 主 Agent 通过 `recommend_permission` 返回 `approve_once / reject / escalate`。
  - 主 Agent 无法直接调用 OpenCode 权限回复，也不能授予 `always`。
- 人工权限中心：
  - 查看待审批请求、所属 Agent、动作、资源、上下文和风险。
  - 支持“允许一次”“本任务始终允许”“拒绝”。
  - 通过 SSE 实时刷新。
- 新增公开 API：
  - `GET /api/permissions`
  - `POST /api/permissions/:id/decision`
  - `GET /api/audit`
- 新增内部 Tool API：
  - `POST /internal/orchestrator/permission-recommendations`

## 验证结果

- 11 项自动化测试全部通过。
- OpenCode 1.17.15 能识别 `spawn_workers` 和 `recommend_permission` 两个项目工具。
- 真实 Session 测试中，主 Agent 调用 `bash: pwd` 后：
  1. OpenCode 产生真实待审批请求；
  2. Control Plane 收到并显示 `bash / HIGH`；
  3. 人工允许一次后 Agent 恢复执行；
  4. 模型返回了真实工作目录结果。
- 浏览器测试中，权限中心正确显示待审批卡片，点击“允许一次”后计数从 1 变成 0，控制台无错误。

## 当前边界

- TaskGroup、Agent、PermissionRequest 和审计记录仍保存在内存中，重启 Control Plane 后本地映射会丢失。
- OpenCode 自身保存的待审批请求会在启动时同步，但只有能映射到当前内存 Agent 的请求才会纳入管理。
- 当前静态策略是面向“只读商品损益排查”的保守默认值，后续应做成项目级可配置策略。

## 下一里程碑建议

里程碑 D 进入持久化与恢复：SQLite/PostgreSQL 数据库、启动时从 OpenCode Session 重建 Agent 映射、任务组历史列表、权限审计长期保存，以及异常重启后的自动恢复。
