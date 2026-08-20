# 后端与团队工作空间部署指南

## 1. 推荐目录

生产环境建议使用两个独立目录：

```text
/opt/opencode-control-plane/       # 后端代码、Web 页面、SQLite
/srv/opencode-team-workspace/      # Agent 配置、工具和实际业务文件
```

源代码仓库中的 `workspace-template/` 只是可复制模板。不要要求 Agent 在后端源码目录工作。

## 2. 安装后端

```bash
git clone <control-plane-repository> /opt/opencode-control-plane
cd /opt/opencode-control-plane
npm install
```

## 3. 创建团队工作空间

仓库中的 `workspace-template/` 是可以提交到 GitHub 的基础模板。换一台电脑后有两种用法：

### 简单方式：直接使用仓库内模板

适合本机开发和快速测试：

```bash
git clone <control-plane-repository>
cd opencode-control-plane
npm install
npm install --prefix "$PWD/workspace-template/.opencode"
OPENCODE_DIRECTORY="$PWD/workspace-template" npm run doctor
```

启动 Control Plane 时继续使用 `OPENCODE_DIRECTORY="$PWD/workspace-template"`。这种方式下，后端和运行工作空间在同一个 Git 仓库中，但仍是两个职责不同的目录。

### 推荐方式：从模板复制出独立工作空间

适合长期使用、生产部署，或者需要把真实业务代码独立管理的情况：

```bash
mkdir -p /srv/opencode-team-workspace
cp -R /opt/opencode-control-plane/workspace-template/. /srv/opencode-team-workspace/
npm install --prefix /srv/opencode-team-workspace/.opencode
```

然后把真实业务内容放进去，例如：

```text
/srv/opencode-team-workspace/
├── opencode.json
├── .opencode/
├── AGENTS.md
├── src/
├── scripts/
├── docs/
└── skills-or-business-files/
```

可以修改 `opencode.json` 中的 Agent 权限，也可以新增 `.opencode/agents/*.md` 和 `.opencode/skills/*/SKILL.md`。

独立工作空间可以建立自己的 Git 仓库，也可以仅作为本机运行目录。不要提交 API Key、OpenCode 登录信息、Control Plane Token 或 SQLite 数据库；这些由每台机器单独配置。

模板当前在工作空间 `opencode.json` 中固定使用 `ali/qwen3-coder-plus`，避免 OpenCode 回退到最近使用的免费模型。目标机器没有 `ali` Provider 时，必须把它改成该机器的可用模型，或者通过 Control Plane 环境变量覆盖。

## 4. 启动 OpenCode Server

OpenCode Custom Tool 在 OpenCode Server 进程中运行，因此下面三个变量必须提供给这个进程：

```bash
OPENCODE_SERVER_PASSWORD=change-me \
CONTROL_PLANE_URL=http://127.0.0.1:4100 \
CONTROL_PLANE_TOOL_TOKEN=change-tool-token \
opencode serve --hostname 127.0.0.1 --port 4096
```

不需要从团队工作空间目录启动 OpenCode Server。Control Plane 会在每个请求中携带工作空间的绝对路径。

## 5. 诊断并启动 Control Plane

在另一个终端中：

```bash
cd /opt/opencode-control-plane

OPENCODE_BASE_URL=http://127.0.0.1:4096 \
OPENCODE_SERVER_PASSWORD=change-me \
CONTROL_PLANE_URL=http://127.0.0.1:4100 \
CONTROL_PLANE_TOOL_TOKEN=change-tool-token \
OPENCODE_DIRECTORY=/srv/opencode-team-workspace \
npm run doctor
```

诊断会检查：

- 工作空间目录存在；
- 存在 `opencode.json` 或 `opencode.jsonc`；
- 存在 `.opencode/tools`；
- OpenCode Server 健康且路由完整；
- OpenCode 已从该工作空间加载主 Agent、审批 Agent 和默认 Worker。

诊断通过后，用同样的环境变量启动：

```bash
OPENCODE_BASE_URL=http://127.0.0.1:4096 \
OPENCODE_SERVER_PASSWORD=change-me \
CONTROL_PLANE_URL=http://127.0.0.1:4100 \
CONTROL_PLANE_TOOL_TOKEN=change-tool-token \
OPENCODE_DIRECTORY=/srv/opencode-team-workspace \
npm start
```

默认页面地址是 `http://127.0.0.1:4100`。

## 6. 指定模型

若不使用 OpenCode 默认模型，可以同时设置：

```bash
OPENCODE_PROVIDER_ID=ali
OPENCODE_MODEL_ID=qwen3-coder-plus
```

建议在团队首次联调时显式设置这两个变量。若工作空间和全局配置都没有指定默认模型，OpenCode 会按自身的最近使用记录或可用 Provider 选择模型，可能意外选中有频率限制的免费模型。页面长时间停留在“正在思考”且 OpenCode 日志出现 “Rate limit exceeded” 时，停止并重新启动 Control Plane，显式指定一个当前可用的 Provider 和 Model 即可；OpenCode Server 本身不必重启。

两个变量必须一起设置。也可以直接在团队工作空间的 `opencode.json` 中加入：

```json
{
  "model": "ali/qwen3-coder-plus"
}
```

不要把 API Key 提交到团队工作空间仓库；使用 OpenCode 支持的用户级配置或环境变量管理凭证。

OpenCode 选择模型时，本项目相关的顺序是：

1. Control Plane 设置了 `OPENCODE_PROVIDER_ID` 和 `OPENCODE_MODEL_ID` 时，每次消息请求都会显式携带该模型；
2. 否则使用 OpenCode 合并配置中的 `model`，工作空间项目配置会覆盖用户级全局配置；
3. 合并配置仍没有 `model` 时，OpenCode 尝试最近使用且当前仍可用的模型；
4. 最后才从当前可用 Provider 中选择一个模型。

因此，换电脑后最稳定的做法是在工作空间 `opencode.json` 中设置默认模型，或者在启动 Control Plane 时显式提供两个模型变量。Provider 凭证仍放在该电脑的 OpenCode 用户配置或认证存储中，不随 Git 仓库迁移。

## 7. 查看最终合并配置

必须在团队工作空间目录执行，才能看到该工作空间的 Agent、工具和权限：

```bash
cd /srv/opencode-team-workspace
opencode debug config
opencode debug agent control-plane-main
opencode debug agent control-plane-worker
opencode debug agent permission-approver
opencode debug paths
```

- `opencode debug config`：输出用户级配置、环境指定配置和当前工作空间配置合并后的结果；
- `opencode debug agent <name>`：输出某个 Agent 最终解析到的 prompt、工具和 permission；
- `opencode debug paths`：显示 OpenCode 的全局配置、状态、日志和缓存目录。

`opencode debug config` 可能包含 Provider 的详细配置，不要把未经检查的完整输出直接发给别人。只检查模型与 Agent 名称时，可以使用：

```bash
opencode debug config | jq '{model, agentNames: ((.agent // {}) | keys), providerNames: ((.provider // {}) | keys)}'
```

注意：`OPENCODE_PROVIDER_ID` 和 `OPENCODE_MODEL_ID` 是本项目 Control Plane 的环境变量，不属于 OpenCode 原生配置键。它们的作用是让后端在发送消息时显式携带模型，因此不会出现在 `opencode debug config` 的 `model` 字段中。

## 8. SQLite 与备份

默认数据库位于后端目录：

```text
/opt/opencode-control-plane/.data/opencode-control-plane.sqlite
```

生产环境可以显式设置：

```bash
CONTROL_PLANE_DATABASE_PATH=/var/lib/opencode-control-plane/control-plane.sqlite
```

备份时需要分别考虑：

- Control Plane SQLite；
- 团队工作空间 Git/文件；
- OpenCode Server 自己保存的 Session 历史。

## 9. 容器或不同机器

当前 Diff 功能要求 Control Plane 和 OpenCode Server 都能访问 `OPENCODE_DIRECTORY`。推荐把同一个卷挂载到相同绝对路径：

```text
Control Plane 容器：/workspace/team
OpenCode 容器：     /workspace/team
OPENCODE_DIRECTORY=/workspace/team
```

若两个进程不在同一网络命名空间，OpenCode Server 使用的 `CONTROL_PLANE_URL` 必须指向真实可达地址，例如 `http://control-plane:4100`，而不是 `127.0.0.1`。

## 10. 更新配置

修改工作空间中的 Agent、工具或 Skill 后：

1. 完成必要的 `.opencode` 依赖安装；
2. 重启 OpenCode Server，确保旧的项目实例和工具缓存被清理；
3. 运行 `npm run doctor`；
4. 再重启 Control Plane。

旧 TaskGroup 会继续保存原 Session ID。若 OpenCode 侧 Session 已不存在，Control Plane 启动恢复会把对应 Agent 标记为失败，而不会静默创建新上下文。
