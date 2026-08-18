# 里程碑 B 实施结果

完成日期：2026-08-18

## 已完成

- 主 Agent 与 Worker 都映射到独立 OpenCode Session。
- Worker Session 创建时传入主 Session `parentID`。
- `WorkerTask`、Worker Agent角色、状态和错误已加入内存数据模型。
- `spawn_workers` 支持一次创建 1～20 个 Worker。
- `request_id` 幂等：重复请求不会重复创建 Session。
- `MAX_CONCURRENT_WORKERS` 控制 Worker 创建并发，默认 3。
- 新增 OpenCode Custom Tool：`.opencode/tools/spawn_workers.ts`。
- 主 Agent消息注入编排规则，引导其使用 `spawn_workers`，而不是 OpenCode 内置 subagent。
- 页面可手工批量输入费用项、创建 Worker、查看 Agent 列表并切换到任意 Worker 聊天。
- OpenCode Session事件会回写 Agent 的 RUNNING、IDLE、FAILED 状态。
- 检测“assistant 已结束但零 token、空内容”的异常并显示模型提示。
- 支持通过 `OPENCODE_PROVIDER_ID`、`OPENCODE_MODEL_ID` 覆盖模型。

## 真实环境发现与修复

- 默认 `opencode/deepseek-v4-flash-free` 在本次探针中生成了零 token 的空 assistant 消息。
- 已确认 `ali/qwen3-coder-plus` 能在真实 OpenCode `1.17.15` Session 中正常回复 `READY`。
- OpenCode `1.17.15` 的模型字段存在两种形状：
  - 创建 Session：`{ providerID, id }`
  - 发送 Prompt：`{ providerID, modelID }`
- `OpenCodeAdapter` 已分别完成转换，避免模型覆盖导致 `BadRequest`。

## 验证

`npm test`：9 项测试全部通过，包括父子关系、幂等与并发上限。

真实 OpenCode 探针：

- Server：1.17.15
- Provider/Model：`ali/qwen3-coder-plus`
- 输出：`READY`

## 下一步

里程碑 C：Permission Manager。

- 捕获和持久化待审批请求。
- 静态 allow/deny/escalate 规则。
- 主 Agent结构化审批建议。
- 人工审批页面。
- `once/always/reject` 回复适配与审计。
