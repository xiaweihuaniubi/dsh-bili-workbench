# dsh-bili-workbench

DSH（DeepSeek Harness）B站工作台：素材采集、创作方案、原声混剪、渲染和人工审核投稿。MIT，保留原项目作者与第三方署名。

## 环境
- DSH >= 0.2.1-rc.1、Node.js >= 22；当前维护环境实际使用DSH 0.2.1-rc.2 / Windows，其他系统待用户验证。
- Python/uv、bili-agent（命令bili）、edge-tts、yt-dlp、FFmpeg及ffprobe（含libass）、Chrome/Edge。
- Remotion/React/sharp由插件依赖安装；视频下载和模型调用还受各自服务可用性影响。

## 安装

发布v1.3.0标签之后，可安装固定版本：

```powershell
dsh plugin --profile web add "github:Userluckytian/dsh-bili-workbench#v1.3.0"
```

下载Release的tgz后也可本地安装（把路径换成实际下载位置）：

```powershell
dsh plugin --profile web add "C:\Downloads\dsh-bili-workbench-1.3.0.tgz"
```

安装后重启DSH，再刷新页面。发布前本地试用：在解压源码目录执行npm install，然后运行dsh plugin --profile web add "link:$PWD"。不要同时加载老的刷B站插件。

外部命令请自行安装：

```powershell
uv tool install bili-agent
uv tool install edge-tts
uv tool install yt-dlp
winget install Gyan.FFmpeg
```

重开终端，确认bili --version、edge-tts --version、yt-dlp --version、ffmpeg -version和ffprobe -version能执行。Windows还需安装Chrome或Edge；其他系统可通过BILI_OP_CHROME指定浏览器路径。

## 首次使用
1. 打开任一DSH会话的“B站工作台”，进入“我的”扫码登录自己的账号。
2. 在独立的“刷B站设置”配置关键词、频率和音色。自动采集、自动评论、自动回复、私信监听、投稿权限默认关闭；按需手动开启。
3. 未配置独立模型密钥时复用DSH当前模型。独立模型可通过OC_API_KEY和BILI_OP_LLM_BASE配置，修改环境变量后重启DSH；不要将真实密钥提交GitHub。
4. 创作中心选择A吐槽整活、B名场面混剪、C自定义。素材不足会创建采集任务；生成方案不等于自动渲染或投稿。
5. B正文纯原声，片头实际不超过3秒、片尾简短；切点按完整台词和包袱确定，不固定几秒强切。
6. 修改会生成v2/v3等新方案版本。确认后手动渲染，在“成片投稿”预览、本地审核，再检查参数和提交。取得BV仅代表提交，需同步平台审核状态。

数据默认在用户目录.dsh-bili-workbench/store，可在“我的”切换。BILI_ASSETS可指向自己的素材目录；内置通用几何占位形象，不包含维护者的视频、头像、素材包、账号或密钥。

## 发布与维护

- [项目功能说明](docs/FEATURES.zh-CN.md)
- [GitHub提交、Release及用户安装指南](docs/GITHUB-PUBLISHING.zh-CN.md)
- [更新记录](CHANGELOG.md)
- [第三方说明](NOTICE.md)

本包不是自带全部环境的一键安装程序；用户仍需安装DSH、外部命令和浏览器。普通GitHub源码ZIP不会自动安装依赖。
