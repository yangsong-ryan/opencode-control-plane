# OpenCode 多 Agent 任务管理平台思路说明

## 一、需求背景

我日常开发主要使用 OpenCode。

目前有一个比较固定的工作场景：需要对比两边商品损益看板的数据，排查不同费用项的数据差异。我已经写好了一个 Skill，能够处理单个字段的问题。正常情况下，我把某一个费用字段的问题交给 OpenCode，它就可以按照 Skill 自己读取代码、查询数据、查看日志并分析原因。

现在的问题是：如果一次需要排查多个字段，我就需要手工打开多个 OpenCode 窗口，把每个字段的问题分别发给不同窗口，然后分别查看进度、继续沟通，并处理每个窗口弹出的权限申请。

当字段数量比较多时，这个过程会产生很多重复操作。因此，我希望做一个系统，帮助我统一管理多个 OpenCode 任务。

## 二、核心想法

我不希望重新实现大模型，也不希望自己重新开发一套 Agent Runtime。

我的设想是继续使用 OpenCode 作为底层 Agent Runtime，使用 OpenCode 已有的 Session、上下文、工具调用、Skill 执行和权限机制。在 OpenCode 外面增加一个自己的后端和管理页面，负责创建和管理多个 OpenCode Session，并组织它们之间的关系。

这个系统可以理解为一个 OpenCode Control Plane，主要负责：

- 创建和管理 OpenCode Session；
- 把一个批量任务拆成多个独立任务；
- 把每个任务分配给独立的 OpenCode Session；
- 查看每个 Session 的聊天记录和运行状态；
- 允许用户继续和任意 Session 对话；
- 集中处理所有 Session 的权限申请；
- 收集各个 Session 的结果，并由主 Agent统一汇总。

## 三、主 Agent和 Worker 的关系

系统中会有一个主 Agent和多个 Worker。

这里的主 Agent和 Worker，不是指 OpenCode 内部的 subagent。我的想法是，它们在 OpenCode 底层都对应独立的 Session。

例如：

- 主 Agent对应一个独立 OpenCode Session；
- 商品毛利 Worker 对应一个独立 OpenCode Session；
- 履约费用 Worker 对应一个独立 OpenCode Session；
- 平台补贴 Worker 对应一个独立 OpenCode Session；
- 广告费用 Worker 对应一个独立 OpenCode Session。

这些 Session 在 OpenCode 底层可以是相互独立的。谁是主 Agent、谁是 Worker、哪个 Worker 属于哪个主 Agent，由我们自己的后端数据库维护。

这样设计的主要原因是：我希望每个 Worker 都有独立的聊天历史、上下文和运行状态。我可以在 Web 页面中点进任意 Worker，查看它完整的执行过程，也可以直接继续和它对话。

## 四、预期使用流程

一次完整的使用流程大致如下：

1. 我在 Web 页面中创建一个批量排查任务，系统同时创建一个主 Agent对应的 OpenCode Session。
2. 我告诉主 Agent：需要排查某个钉钉文档中的多个费用项。
3. 主 Agent读取钉钉文档，提取需要排查的字段。
4. 主 Agent为每个字段生成一个独立的排查任务。
5. 主 Agent通过后端提供的受控工具申请创建 Worker。
6. 后端为每个 Worker 创建独立的 OpenCode Session，并把对应字段、文档上下文和已有 Skill 交给它。
7. 多个 Worker 并行执行各自的字段排查。
8. Web 页面统一显示主 Agent和所有 Worker 的状态、聊天信息、执行进度和权限申请。
9. 我可以随时进入某个 Worker，继续提问、补充信息或纠正方向。
10. 所有 Worker 完成后，主 Agent读取各个 Worker 的结论，并生成一份统一汇总。

## 五、主 Agent如何创建 Worker

我不希望主 Agent直接获得随意操作 OpenCode Server 的权限。

更合适的方式是：后端给主 Agent提供一些受控工具，例如：

- `spawn_worker`：申请创建一个 Worker；
- `list_workers`：查看当前所有 Worker；
- `get_worker_status`：查询 Worker 状态；
- `send_worker_message`：向 Worker 发送消息；
- `terminate_worker`：终止某个 Worker。

主 Agent在分析完任务以后调用 `spawn_worker`，后端负责校验参数、Worker 数量、并发上限和任务范围，然后才真正调用 OpenCode 创建 Session。

这样可以避免主 Agent无限创建 Worker，也可以在后端统一管理 Session 生命周期。

## 六、权限审批思路

权限审批是这个系统中比较重要的部分。

每个 Worker 都是独立的 OpenCode Session，因此每个 Worker 在执行命令或访问资源时，都可能产生自己的权限请求。

我的目标是：这些请求不需要我分别进入多个窗口处理，而是全部进入后端的 Permission Manager，由系统统一处理。

我目前设想的审批顺序是：

1. 静态规则自动判断；
2. 静态规则无法判断时，由主 Agent给出建议；
3. 高风险或不确定的请求，交给人工审批。

例如：

- 读取代码、搜索文件、查询日志、执行白名单中的只读查询脚本，可以自动允许；
- 删除文件、写数据库、推送代码、修改权限配置，可以直接拒绝或者必须人工审批；
- 没有命中已有规则，但看起来可能合理的操作，可以让主 Agent结合任务上下文给出 approve、reject 或 uncertain 的建议；
- 涉及敏感数据、共享环境写操作或无法确认风险的请求，必须由人工决定。

一个重要原则是：真正调用 OpenCode 权限接口并完成批准或拒绝的，应该始终是后端 Permission Manager。

主 Agent只能作为决策建议者，不应该直接持有不受限制的权限审批 API。即使主 Agent建议允许，后端也应该再次检查安全规则。

如果需要人工审批，Web 页面统一展示：

- 哪个任务组产生的请求；
- 哪个 Worker 产生的请求；
- 对应的 OpenCode Session；
- 准备执行什么命令或访问什么资源；
- 主 Agent的建议和理由；
- 可以选择允许一次、在限定范围内允许或拒绝。

## 七、后端需要负责的事情

后端可以大致分为几个部分：

### 1. Agent Manager

管理任务组、主 Agent、Worker，以及它们之间的逻辑主子关系。

### 2. Session Manager

维护逻辑 Agent和 OpenCode Session 之间的映射，负责创建 Session、发送消息、读取聊天历史、恢复、取消和终止 Session。

### 3. Orchestrator

负责让主 Agent能够通过受控工具创建 Worker、查询 Worker、发送消息和汇总状态。

### 4. Permission Manager

统一接收 OpenCode 的权限请求，执行静态规则、主 Agent建议和人工审批，并把最终结果回复给 OpenCode。

### 5. Event Router

监听 OpenCode 的消息、状态和权限事件，转换成我们自己的业务状态，再实时推送给 Web 页面。

### 6. Result Aggregator

收集每个 Worker 的排查结果，在满足条件时通知主 Agent进行统一汇总。

## 八、Web 页面希望具备的能力

第一阶段暂时不需要重点设计页面样式，但至少需要支持：

- 查看所有批量任务；
- 查看一个任务中的主 Agent和所有 Worker；
- 查看每个 Agent的运行状态；
- 查看主 Agent和 Worker 的完整聊天记录；
- 继续向主 Agent或任意 Worker 发送消息；
- 查看并处理全部权限请求；
- 暂停、取消、恢复或重新运行某个 Worker；
- 查看单字段结果和最终汇总结果。

## 九、Session 独立和工作空间独立

还需要区分两个概念：Session 独立和工作空间独立。

即使每个 Worker 都有独立 Session，如果它们都在同一个项目目录中执行任务，那么一个 Worker 修改的文件，其他 Worker 仍然能够看到。

第一版主要用于读代码、查数据、查日志和分析问题，可以先共享工作空间，降低实现复杂度。

如果以后需要多个 Worker 同时修改代码，可以考虑：

- 每个 Worker 使用独立 git worktree；
- 每个 Worker 使用独立容器或沙箱；
- 不同 Worker 使用不同的最小权限凭证。

## 十、Edict 项目带来的参考

我之前参考过 Edict（三省六部）项目。

这个项目的思路和我的设想有相似之处：它也没有自己实现大模型和完整 Agent Runtime，而是使用 OpenClaw 作为底层 Runtime，然后自己实现角色关系、任务流转、权限矩阵、状态管理和 Web 看板。

这个项目说明“现有 Agent Runtime + 外部编排和管理层”的方向是可行的。

但 Edict 使用的是 OpenClaw，而且混合使用了独立 Agent 通信和 OpenClaw subagent。我的需求更强调每个 Worker 都是独立、长期存在、可以直接聊天和单独审批的 OpenCode Session，所以不能直接照搬 Edict 的 Session 和权限实现，只能参考它的任务状态、组织关系、审计和看板思路。

## 十一、第一版建议范围

第一版不需要做成通用的 Agent Teams 平台，可以只服务于“商品损益看板多个费用字段批量排查”这个固定场景。

第一版优先实现：

- 创建一个主 Agent Session；
- 输入费用字段清单；
- 批量创建独立 Worker Session；
- 多个 Worker 并行运行；
- 查看聊天历史并继续对话；
- 静态权限规则和人工审批；
- 单字段结构化结果；
- 主 Agent统一汇总；
- Worker 失败重试、超时和取消；
- 基础运行和审批审计。

第一版暂时不需要实现：

- 通用型 Agent Teams；
- 主 Agent自主审批所有未知权限；
- 多机器分布式调度；
- 自动修改和提交生产代码；
- 完整的企业级多租户、计费和配额体系。

## 十二、希望公司 Agent继续设计和验证的内容

希望公司 Agent基于以上思路，重点完成以下工作：

1. 验证公司当前 OpenCode 版本的 Server、SDK、Session、消息、事件和 Permission API 能力。
2. 确认能否通过外部程序创建独立 Session、异步启动任务、读取完整聊天历史、查询状态、取消任务和回复权限请求。
3. 设计后端整体架构、核心数据对象、接口和时序。
4. 设计主 Agent调用 `spawn_worker` 等工具的具体协议、参数、并发限制、幂等和安全规则。
5. 设计 Permission Manager 的静态规则、风险等级、审批范围、超时、撤销和审计机制。
6. 设计如何防止 Worker 或钉钉文档中的内容通过提示词注入影响主 Agent的权限判断。
7. 设计 OpenCode Session、进程、工作目录、数据库凭证和沙箱之间的隔离方式。
8. 确认钉钉文档的读取、身份认证、权限继承和敏感信息处理方案。
9. 确定消息和运行记录应该以 OpenCode 为事实源，还是同步保存到自己的数据库。
10. 给出一个可以落地的 MVP 技术方案和迭代计划。

## 十三、项目定位

这个项目不是重新开发一个 Coding Agent，也不是重新实现 OpenCode。

它更适合被定义为一个面向批量数据排查场景的 OpenCode Control Plane。

它的核心价值是：

- Session orchestration；
- Permission routing；
- Human-in-the-loop；
- 运行状态和聊天可观测；
- 多 Worker 结果汇总。

第一版先解决商品损益看板多字段批量排查问题，复用现有的单字段 Skill。在真实使用中验证 Session 编排和权限控制是否可行，再决定是否扩展为通用的 Agent Teams 管理平台。
