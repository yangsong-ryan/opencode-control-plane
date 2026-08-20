# 团队 OpenCode 工作空间模板

这个目录不是 Control Plane 后端代码目录，而是主 Agent、审批 Agent 和所有 Worker 实际工作的项目根目录。

复制这个目录后，可以把业务代码、查询脚本、Skill、数据说明和其他项目文件放在同一工作空间中：

```text
team-workspace/
├── opencode.json            # OpenCode 模型与原生 Agent 权限
├── AGENTS.md                # 可选：整个工作空间的公共说明
├── .opencode/
│   ├── agents/              # 可选：额外 Markdown Agent 定义
│   ├── skills/              # 可选：项目级 Skill
│   └── tools/               # Control Plane 自定义工具桥接
├── src/                     # 示例：业务代码
├── scripts/                 # 示例：查询或诊断脚本
└── docs/                    # 示例：数据口径与任务资料
```

`opencode.json` 当前显式使用 `ali/qwen3-coder-plus`，避免 OpenCode 在没有默认模型时回退到本机最近使用的免费模型。部署到没有 `ali` Provider 的机器时，请把 `model` 改成该机器 `opencode models` 输出中的可用模型，或启动 Control Plane 时同时设置 `OPENCODE_PROVIDER_ID` 和 `OPENCODE_MODEL_ID` 覆盖它。

启动 OpenCode Server 和 Control Plane 时，把 `OPENCODE_DIRECTORY` 设置为这个目录的绝对路径。自定义工具运行在 OpenCode Server 进程中，因此 OpenCode Server 进程必须能读取 `CONTROL_PLANE_URL` 和 `CONTROL_PLANE_TOOL_TOKEN`。

## 复制后首次安装

```bash
npm install --prefix /absolute/path/to/team-workspace/.opencode
```

然后检查 OpenCode 最终加载到的配置：

```bash
cd /absolute/path/to/team-workspace
opencode debug config
opencode debug agent control-plane-main
opencode debug agent control-plane-worker
opencode debug agent permission-approver
```

## 修改默认 Agent

三个核心 Agent 直接定义在 `opencode.json` 的 `agent` 字段中：

- `control-plane-main`：接收用户任务、发现和管理 Worker；
- `control-plane-worker`：持续执行任务，并通过 `ask_main_agent` 向主 Agent 提问；
- `permission-approver`：只审核后端转发的未知权限请求。

修改 `prompt` 可以改变角色行为，修改 `permission` 可以控制工具可见性和执行方式：

```json
{
  "permission": {
    "*": "deny",
    "read": "allow",
    "grep": "allow",
    "glob": "allow",
    "bash": "ask"
  }
}
```

- `deny`：工具不发送给模型；
- `allow`：工具可见，并由 OpenCode 直接执行；
- `ask`：工具可见，调用后进入 Control Plane 权限流程。

## 新增业务 Agent

可以继续在 `opencode.json` 的 `agent` 字段增加，也可以新增 Markdown 文件：

```text
.opencode/agents/sql-investigator.md
```

示例：

```markdown
---
description: 只读排查 SQL、数据口径和上下游依赖
mode: primary
permission:
  "*": deny
  read: allow
  grep: allow
  glob: allow
  bash: ask
  ask_main_agent: allow
---

只进行排查和分析。遇到业务口径不明确时调用 ask_main_agent。
```

文件名就是 Agent 名称。主 Agent 通过 `list_agent_types` 发现它，并在创建 Worker 时把该名称发送给 OpenCode。

## 修改后生效

1. 重启 OpenCode Server；
2. 在后端目录运行 `OPENCODE_DIRECTORY=/absolute/path/to/team-workspace npm run doctor`；
3. 重启 Control Plane；
4. 新建 Agent Team 测试。旧团队如果对应 Session 已不存在，不会自动换成新 Session。
