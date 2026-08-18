# 里程碑 D：SQLite 持久化与重启恢复

## 已完成

- 新增 Node.js 内置 `node:sqlite` 存储实现，不增加 npm 依赖。
- 自动创建 SQLite 数据库、WAL 模式和版本迁移表。
- 持久化以下对象：
  - TaskGroup
  - AgentInstance
  - WorkerTask
  - Worker 批次幂等键
  - PermissionRequest
  - AuditRecord
- 默认数据库路径：`.data/opencode-control-plane.sqlite`。
- 支持 `CONTROL_PLANE_DATABASE_PATH` 自定义数据库文件。
- 服务安全关闭前刷新并关闭数据库连接。
- 启动时读取全部本地状态，并与 OpenCode Session 列表对账：
  - Session 仍存在：保留 Agent，并把中断时的 `RUNNING / CREATING` 恢复为 `READY`。
  - Session 已不存在：Agent 标记为 `FAILED`；对应 WorkerTask 也标记失败；主 Session 缺失时 TaskGroup 标记失败。
- 启动恢复结果写入审计记录并暴露在 `/health`。
- 新增 `GET /api/task-groups` 历史任务接口。
- 页面新增“最近任务”，服务重启后可以重新进入原 TaskGroup、主 Agent 和 Worker。
- 运行时数据库目录加入 `.gitignore`，避免误提交本地状态。

## 验证结果

- 13 项自动化测试全部通过。
- SQLite 文件关闭后重新打开，TaskGroup、Worker、权限、审计和幂等键均能恢复。
- 使用两个独立 Node 进程完成跨进程重启验证：
  - 第一个进程写入 `RUNNING` Agent 后退出；
  - 第二个进程打开同一数据库，读取到原任务；
  - 与仍存在的 Session 对账后，Agent 从 `RUNNING` 恢复为 `READY`。
- 另有测试覆盖 Session 缺失场景：Agent 与 TaskGroup 会被明确标记为失败，不会显示成假运行状态。
- 页面脚本语法和历史任务入口由自动化测试验证。

## 实现取舍

第一版使用“小规模状态快照 + SQLite 事务”的方式保存多张对象表。它的优点是逻辑简单、每次修改原子落盘、非常适合当前单用户本地工具；当任务量显著增大后，可以把它替换成逐行 UPSERT 或 PostgreSQL，而不改变上层 Orchestrator、Permission Manager 和页面 API。

OpenCode 的完整聊天记录仍由 OpenCode 保存，Control Plane 只持久化 Session ID 和管理状态，不复制模型消息。

## 当前边界

- Session 缺失时会标记失败，但不会擅自创建替代 Session，因为新 Session 无法天然继承原模型上下文。
- 目前没有任务归档、删除和数据库备份界面。
- 当前仍是单进程本地服务；不支持多个 Control Plane 实例同时写同一个数据库。

## 下一里程碑建议

里程碑 E 可以开始接入真实业务入口：钉钉文档读取、字段提取、任务模板和商品损益 Skill 注入。这样用户只需给主 Agent 一个钉钉文档或任务描述，系统就能自动创建字段 Worker。
