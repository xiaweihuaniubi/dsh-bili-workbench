/**
 * prompts.mjs —— 资讯盘点这一档的提示词（写死口径，别让模型自由发挥）
 *
 * 为什么这么写：
 *  · 模型一次给全（标题 + 分镜 + 旁白），少一次往返，省时间也省 token
 *  · 旁白按"口语短句"约束，因为后面要直接喂 TTS；写成书面长句朗读会很别扭
 *  · 每镜的字数卡死，总字数落在 250–380 字 ⇒ 中文 TTS 约 55–85 秒
 */

export const SYSTEM = `你是 B 站「资讯盘点」栏目的编导，负责把一周内的新鲜事整理成一期 60–90 秒的短视频脚本。
你的输出会被程序直接解析成 JSON 去渲染视频，所以：
- 只输出 JSON，不要解释、不要 markdown、不要代码块围栏
- 所有文字用简体中文
- 不用 emoji、不用「【】」这类装饰符号
- 旁白要**口语、短句、适合朗读**，别写书面长句`

/** @param {{theme:string, date:string, tone:string, count:number}} opts */
export function userPrompt({ theme, date, tone, count = 5 }) {
  return `今天是 ${date}。主题：${theme}。语气：${tone || '轻松但不油腻，像在跟朋友聊'}。

请写一期资讯盘点，结构必须是：
1. 第 1 镜 kind="title"：栏目开场（headline 是本期标题 ≤ 20 字；sub 是一句话副标题 ≤ 24 字）
2. 中间 ${count} 镜 kind="item"：每条资讯一镜
   - headline：这条资讯的标题点 ≤ 16 字
   - body：一句话说清「发生了什么」≤ 40 字（会显示在画面卡片上）
   - badge：2–4 个字的小标签，比如「模型」「价格」「开源」
   - narration：这一镜要念的旁白，**30–45 字**，口语、有信息量、不吹不黑
3. 可选 1 镜 kind="data"：给一组数字（stats 是 3–4 个 {label, value}，label ≤ 6 字，value ≤ 10 字）
4. 最后 1 镜 kind="outro"：收尾一句（headline ≤ 18 字；sub ≤ 20 字）

硬性要求：
- 全部 narration 加起来 **250–380 个汉字**（总片长才落在 60–90 秒）
- 每条 narration 都必须读起来像人话，**不许出现「首先/其次/综上」这类作文腔**
- 不许编造具体数字；拿不准就不写数据镜

只输出这样的 JSON：
{
  "title": "本期标题",
  "subtitle": "副标题",
  "shots": [
    { "kind": "title", "headline": "...", "sub": "...", "narration": "..." },
    { "kind": "item", "index": 1, "headline": "...", "body": "...", "badge": "...", "narration": "..." },
    { "kind": "data", "headline": "...", "stats": [{ "label": "...", "value": "..." }], "narration": "..." },
    { "kind": "outro", "headline": "...", "sub": "...", "narration": "..." }
  ]
}`
}
