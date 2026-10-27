# B站工作台：GitHub 提交与下载发布指南

更新日期：2026-10-27。适用于本次准备的 `dsh-bili-workbench 1.3.0`。

## 1. 本次准备了什么

当前运行的插件仍在 `F:\dsh\home\profiles\web\node_modules\dsh-bili-workbench`。这是安装目录，不是 Git 源码仓库，**不要直接把整个目录上传**。

本次准备的干净源码在：

```text
F:\dsh\release-prep\20261027\dsh-bili-workbench
```

打包附件放在：

```text
F:\dsh\release-prep\20261027\artifacts
```

源码包括本次表单控件、独立设置菜单、紧凑创作中心、删除确认、渲染和投稿状态修复。发布版默认密钥留空，默认自动采集、评论、回复、私信监听和投稿开关关闭；不包含你的账号、配置、记忆、视频、日志、缓存或依赖目录。原有作者信息、MIT 许可证和第三方说明保留。

发布版使用两张新制作的通用几何占位形象，不复制个人头像；用户可以自行配置素材。运行版个人设置未被修改。发布目录中的 `package.json` 版本为 `1.3.0`，不是视频方案的 v1/v2。

**准备本地源码和 tgz 不等于已经上传或发布。** 本次没有创建 Git 提交、推送、公开 Release 或 npm 发布。

## 2. 推荐的发布方式

沿用现有仓库：

[Userluckytian/dsh-bili-workbench](https://github.com/Userluckytian/dsh-bili-workbench)

建议流程：**克隆现有仓库 → 新建分支 → 合入干净源码 → 检查 → 提交/推送 → 合并 → 打版本标签 → 发布 GitHub Release**。

- Git 仓库保存源码和版本历史。
- GitHub Release 提供版本说明和下载附件。
- npm 包 `.tgz` 是适合安装的源码包，会由 DSH/pnpm 安装依赖；它不是无需环境的一键运行程序。
- 不必先发布到 npm，GitHub 标签和 Release 的 tgz 已能供别人下载使用。

## 3. 把干净源码合入 Git 仓库

以下命令在 PowerShell 手动执行。需要 Git，并具有仓库写权限；如果不是仓库维护者，先 Fork 到自己的账号，替换 URL，并通过 Pull Request 贡献。

### 3.1 克隆和创建分支

```powershell
New-Item -ItemType Directory -Force 'F:\dsh\github' | Out-Null
git clone https://github.com/Userluckytian/dsh-bili-workbench.git 'F:\dsh\github\dsh-bili-workbench'
Set-Location 'F:\dsh\github\dsh-bili-workbench'
git switch -c codex/workbench-1.3.0
git status --short
```

若目标目录已经存在，不要覆盖或重新初始化。进入已有仓库，先看 `git status`、`git remote -v` 和当前分支，保存已有改动后再拉取/合入。不要使用 `git push --force` 解决冲突。

### 3.2 复制本次整理的源码

只从本次干净目录复制，不从 `F:\dsh\home`、`store` 或 `assets-src` 复制：

```powershell
$releaseSource = 'F:\dsh\release-prep\20261027\dsh-bili-workbench'
$releaseRepo = 'F:\dsh\github\dsh-bili-workbench'
Get-ChildItem -LiteralPath $releaseSource -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $releaseRepo -Recurse -Force
}
Set-Location $releaseRepo
git status --short
git diff --stat
git diff --check
```

复制保留上游 `.git` 和未涉及的文件。现有 README、工作流、package-lock 等若有近期上游变更，应逐项看差异再合并，不盲目覆盖。新增 `check.yml` 只做检查，不自动公开发布。上游若已有发布工作流，推送标签前先核对其触发条件与权限。

尤其确认：

- `index.js` 中 `llmKey` 默认值为空，不把真实密钥填回源码。
- 没有 Cookie、登录 JSON、令牌、`.env`、个人 UID 配置、记忆和账号截图。
- 没有下载片段、关键帧、生成视频和 `node_modules`。
- `LICENSE`、`NOTICE.md`、`CONTRIBUTORS.md` 保留。

如果真实密钥曾被推送到远端，应到对应服务撤销并重新生成；仅从最新文件删除不能清除历史泄漏。

### 3.3 检查和本地体验

```powershell
npm ci
npm run check
npm pack --dry-run
```

`npm run check` 检查 JS 语法、默认密钥留空和必要素材文件；它不是完整业务测试。`npm pack --dry-run` 列出实际进入安装包的文件，检查其中没有个人数据。

安装源码体验：

```powershell
dsh plugin --profile web add "link:$PWD"
```

此命令会改变该 DSH profile 使用的插件来源。推荐先用测试 profile：

```powershell
dsh plugin --profile workbench-preview add "link:$PWD"
```

测试 profile 启动前，通过 `dsh --help` 核对当前版本的 web/端口参数；不要与已运行的 3080 服务抢同一端口。不同 profile 的工作台默认仍可能共享用户目录下的素材库，**并非数据隔离沙箱**；需要隔离时，在“我的”选择独立测试素材目录，且不要开启自动互动或提交真实投稿作为测试。

体验至少覆盖：下拉键盘选择、A/B/C 单选、复选框禁用态、方案改版与历史版本、页面内删除确认、预览、登录查询中、渲染失败提示及投稿状态区分。

## 4. 提交代码和推送

本节会实际创建提交和推送，应在你确认体验通过后执行。

```powershell
Set-Location 'F:\dsh\github\dsh-bili-workbench'
git add -- .
git diff --cached --stat
git diff --cached
git commit -m "feat: improve workbench forms and creation workflow"
git push -u origin codex/workbench-1.3.0
```

在 GitHub 打开该分支的 Pull Request，核对差异并合并到 `main`。本次改动覆盖此前运行版修复，PR 描述应列清创作、渲染、投稿与交互改动，并说明只做了哪些验证。

不要把 GitHub 密码或 Token 写入命令文件、发布文档、Git remote URL 或源码。使用 Git Credential Manager/浏览器正常登录；若使用 GitHub CLI，可人工运行 `gh auth login`。

## 5. 创建版本和 GitHub Release

合并之后从实际将要发布的提交重新打包，不直接拿未合并的开发目录冒充最终版本：

```powershell
git switch main
git pull --ff-only origin main
npm ci
npm run check
New-Item -ItemType Directory -Force '..\release-assets' | Out-Null
npm pack --pack-destination '..\release-assets'
Get-FileHash '..\release-assets\dsh-bili-workbench-1.3.0.tgz' -Algorithm SHA256
git tag -a v1.3.0 -m "Bili workbench 1.3.0"
git push origin v1.3.0
```

如果 `v1.3.0` 已存在或 `package.json` 的版本已经更高，使用新的版本号并同步文档、附件与标签，不覆盖已经发布的标签。

在仓库网页右侧点 **Releases → Draft a new release**：

1. 选择 `v1.3.0`，确认标签指向本次合并后的提交。
2. 标题填 `v1.3.0 · 工作台交互与创作优化`。
3. 粘贴 `CHANGELOG.md` 对应内容，补充环境要求与已知限制。
4. 上传重新打包的 `dsh-bili-workbench-1.3.0.tgz`，可同时上传 SHA256 校验文本。
5. 先保存草稿，检查附件和安装命令；准备公开后点 **Publish release**。

GitHub 自动生成的 Source code ZIP/tar.gz 只有源码，不包含 Node 依赖和 FFmpeg 等环境。建议普通用户下载你附上的 `.tgz`。

CLI 可选方式（先创建草稿；需要已安装并登录 gh）：

```powershell
gh release create v1.3.0 '..\release-assets\dsh-bili-workbench-1.3.0.tgz' --verify-tag --draft --title 'v1.3.0 · 工作台交互与创作优化' --notes-file CHANGELOG.md
```

推送仓库本身与发布 Release 是两步，Release 公开后用户才会看到该下载版本。

## 6. 发给使用者的安装说明

### 6.1 前置环境

- Node.js >= 22，DSH >= 0.2.1-rc.1（维护环境为 0.2.1-rc.2）。
- Python/uv、bili-agent、edge-tts、yt-dlp。
- FFmpeg 与 ffprobe，需要 libass 字幕支持；Chrome 或 Edge。
- 自己的 B站账号与可用模型服务；默认可复用 DSH 当前模型。

Windows 示例：

```powershell
uv tool install bili-agent
uv tool install edge-tts
uv tool install yt-dlp
winget install Gyan.FFmpeg
```

安装后重开终端，逐一确认 `bili --version`、`yt-dlp --version`、`edge-tts --version`、`ffmpeg -version`、`ffprobe -version`。DSH 安装依照其官方说明；插件本身不包含 DSH。

### 6.2 安装插件

标签公开后固定版本安装：

```powershell
dsh plugin --profile web add "github:Userluckytian/dsh-bili-workbench#v1.3.0"
```

或者从 Release 下载 tgz 后安装：

```powershell
dsh plugin --profile web add 'C:\Downloads\dsh-bili-workbench-1.3.0.tgz'
```

以上 `C:\Downloads` 只是示例，请改为真实下载路径。DSH 的 `plugin add` 将参数转交 pnpm，安装插件及 Node 依赖。安装后重启 DSH 并刷新浏览器，在会话顶部进入“B站工作台”。

首次使用先到“我的”登录，再到“刷B站设置”配置采集。默认自动发送和投稿关闭，由用户按需开启；素材和账号保存在其自己的机器上，不会使用维护者账号。

### 6.3 更新和回退

更新时安装新标签或新的 tgz，重启 DSH。升级前备份用户自己的素材库与配置目录；不要在任务运行时更换插件。回退则安装之前已发布的标签/tgz，保留数据目录。未来若有数据格式不兼容，应先在对应版本说明中明确迁移/回退限制。

## 7. 发布前的实际状态

- 本机已有功能与本次表单修改可体验，干净源码与依赖锁文件已准备。
- 本次未上传 GitHub、未发布 npm，也未使用任何账号做真实投稿验证。
- 干净包不携带维护者媒体和外部可执行文件；第三方下载、配音、模型和 B站权限仍由使用者环境提供。
- 当前主要在 Windows + DSH web 环境验证。Linux/macOS、全新设备全流程安装与平台投稿尚需发布前自行试用，不把语法检查等同于跨平台可用保证。
- 下一次准备版本请重新导出变更并重复清理/检查，不能把本次导出脚本当作长期自动同步机制。

## 8. 官方参考

- [GitHub：推送提交与标签](https://docs.github.com/en/get-started/using-git/pushing-commits-to-a-remote-repository)
- [GitHub：创建与管理 Release](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
- [npm：npm pack 与 dry-run](https://docs.npmjs.com/cli/v11/commands/npm-pack/)

DSH 安装参数还核对了本机 `dsh plugin --help`：命令将后续参数转交 profile 目录中的 pnpm；具体启动选项以使用者实际安装版本的帮助为准。
