# 里程碑 A 实施结果

完成日期：2026-08-17

## 已完成

- Node.js 原生 TypeScript、零第三方依赖的 Control Plane。
- 启动时读取 OpenCode `/global/health` 和 `/doc`，按 HTTP method + 规范化 path 探测所需能力。
- `OpenCodeAdapter` 封装 Session 创建、消息历史、异步 Prompt、中止和 SSE 订阅。
- 创建 TaskGroup 时自动创建一个独立的主 OpenCode Session。
- 面向浏览器的 TaskGroup、Agent 消息、历史、中止和 SSE API。
- OpenCode 地址与 Basic Auth 凭证不暴露给浏览器。
- SSE 自动重连与指数退避的基础实现。
- 请求体大小限制、输入校验和统一错误响应。
- 内存版 TaskGroup/Agent 映射；数据库持久化留到后续里程碑。

## 已验证

运行命令：

```text
npm test
```

结果：5 项测试全部通过。

测试覆盖：

1. OpenCode 能力探测和 HTTP 请求形状。
2. 创建 TaskGroup 与主 Session 映射。
3. 异步发送 Prompt、读取消息历史、中止 Agent。
4. 无效输入和不存在资源的错误处理。
5. OpenCode 事件通过 Control Plane SSE 转发。

测试采用进程内 Fetch、HTTP 请求/响应流和 SSE 数据流，不需要真实 OpenCode、模型账号或本地端口权限。

## 当前 API

```text
GET  /health
POST /api/task-groups
GET  /api/task-groups/:id
POST /api/agents/:id/messages
GET  /api/agents/:id/messages
POST /api/agents/:id/abort
GET  /api/events
```

## 下一步

进入里程碑 B：

- 加入 Worker 角色和父子 Agent 关系。
- 实现幂等的 `spawn_workers` 批量工具入口。
- 用受控队列限制 Worker 并发。
- 创建 Worker Session 时传递主 Session `parentID`。
- 给每个 Worker 异步下发独立 Prompt。
- 增加 `WorkerTask` 和 `AgentRun` 状态。
