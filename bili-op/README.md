# bili-op（出片引擎）

工作台内置的出片流水线：

```text
方案 / 主题
  → 生成 script.json + shots
  → edge-tts 配音（逐句 SRT）
  → Remotion 渲染（真实帧 / 文字卡 / 图表）
  → ffmpeg 合音轨 + 可选烧字幕
  → sharp 生成封面
  → runs/<日期-标题>/status.json + final-subbed.mp4
```

## 依赖

- Node.js 22+
- `ffmpeg`（带 libass）
- `edge-tts`（`uv tool install edge-tts`）
- Chrome 或 Edge（Remotion 渲染；自动探测，也可用 `BILI_OP_CHROME` 指定）
- 一个 OpenAI 兼容模型端点（写方案 / 判定）

## 配置

| 环境变量 | 说明 |
|---|---|
| `BILI_OP_LLM_BASE` | 模型端点，默认 `http://127.0.0.1:40080/v1` |
| `OC_API_KEY` | 模型密钥 |
| `BILI_OP_MODELS` | 模型链，逗号分隔；失败自动换下一个 |
| `BILI_OP_CHROME` | Chrome / Edge 可执行文件 |
| `BILI_OP_DIR` | 本目录位置（工作台默认自动找） |

## 单独跑

在仓库根目录先 `npm install`（依赖在根 `node_modules`，`build.mjs` 会按 Node 解析规则找）。

```bash
node bili-op/gen.mjs "本周 AI 圈发生了什么" --count 5
node bili-op/tts.mjs runs/<runId>
node bili-op/build.mjs --run runs/<runId>
```

也可以直接 `node bili-op/build.mjs --theme "主题" --count 5` 走完整链路。

## 授权

Remotion 不是 OSI 许可证；个人 / 小团队免费，商业使用请阅读
<https://www.remotion.dev/license>。本项目不代替使用者取得商业授权。
