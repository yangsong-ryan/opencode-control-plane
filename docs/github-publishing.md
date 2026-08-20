# 发布到 GitHub

## 本地目录名与仓库名

本地文件夹名不需要与 GitHub 仓库名一致。Git 通过 Remote URL 建立关联，例如本地目录叫 `referenced-chatgpt-conversation-this-is-untrusted`，远端仓库仍然可以叫：

```text
opencode-control-plane
```

这不会影响提交历史、分支、安装、启动或其他电脑执行 `git clone`。其他电脑克隆时，Git 默认使用远端仓库名创建本地目录；也可以在 `git clone` 后额外指定任意本地目录名。

项目 `package.json` 中的包名是 `opencode-control-plane`，建议 GitHub 仓库也使用这个名称，便于识别，但不是技术要求。

`package.json` 中的 `"private": true` 只用于防止误发布到 npm，不会阻止项目推送到 Public 或 Private GitHub 仓库。

## 第一次发布

推荐先在 GitHub 创建一个空仓库：

- 仓库名建议使用 `opencode-control-plane`；
- 根据实际需要选择 Private 或 Public；
- 不要在 GitHub 页面预先生成 README、`.gitignore` 或 License，避免与本地已有提交产生无意义的分叉。

当前项目还没有选择开源 License。如果仓库设为 Public，并希望允许其他人使用、修改和分发代码，发布前应明确选择合适的 License；如果暂时不确定，可以先使用 Private 仓库。

创建后复制仓库 URL，例如：

```text
https://github.com/<owner>/opencode-control-plane.git
```

标准 Git 仓库可以这样关联和推送：

```bash
git remote add origin https://github.com/<owner>/opencode-control-plane.git
git remote -v
git push -u origin main
```

也可以使用 GitHub CLI：

```bash
gh repo create <owner>/opencode-control-plane --private --source=. --remote=origin --push
```

执行前需要在当前电脑完成 GitHub 登录或 SSH Key 配置。

## 当前开发目录的特殊情况

当前 Codex 工作目录的 Git 元数据保存在 `.git-local/`，而不是标准 `.git/`，并且还没有配置 Remote。这不影响项目内容或最终 GitHub 仓库；发布时可以保留现有提交历史并为它添加 Remote。其他电脑从 GitHub 克隆后会得到正常的 `.git/`。

如果希望由 Codex 完成推送，请先执行以下任一方式：

1. 在 GitHub 创建空仓库，把仓库 URL 发给 Codex；
2. 明确授权 Codex 使用已经登录的 GitHub CLI 创建仓库，并说明仓库名、所属账号或组织以及公开性。

推送属于外部写操作。Codex 在得到明确仓库地址或创建授权后，才会配置 Remote 和执行 Push。

## 推送前检查

提交前至少执行：

```bash
npm test
npm run verify:agents
git status
git diff --check
```

确认不要提交：

- `.env` 和 Provider API Key；
- `OPENCODE_SERVER_PASSWORD`、`CONTROL_PLANE_TOOL_TOKEN` 等真实凭证；
- `.data/` 中的 SQLite 数据；
- `node_modules/`、IDE 工作区和本地日志；
- 真实业务数据、内部文档或线上查询结果，除非已经确认允许公开。

仓库会提交 `workspace-template/` 中的基础 Agent、工具和说明，但不会提交其中的依赖安装目录和本地冒烟测试产物。新电脑克隆后需要重新执行：

```bash
npm install
npm install --prefix "$PWD/workspace-template/.opencode"
```
