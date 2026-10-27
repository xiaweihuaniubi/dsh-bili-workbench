/**
 * memory-scan.mjs —— 记忆条目的注入/越权模式扫描
 *
 * 记忆会进 system prompt，等于持久化的提示注入面，所以在两处扫：
 *  · 写入时（add/patch）：命中 → 拒绝整条
 *  · 加载时（renderBlock）：命中 → prompt 里替换成 [BLOCKED]，磁盘原文保留供人工删
 */

const PATTERNS = [
  { re: /忽略(以上|之前|前面|上文).{0,8}(指令|提示|内容|设置|要求|所有)/i, why: '疑似提示注入（忽略指令类）' },
  { re: /(ignore|disregard|forget)\s+(all\s+)?(previous|above|prior|instructions?|prompts?)/i, why: '疑似提示注入（ignore previous）' },
  { re: /(系统提示|系统指令|初始指令|你的提示词|system\s*prompt)/i, why: '涉及系统提示词' },
  { re: /(你现在是|从现在开始你是|你要扮演|你需要扮演|你其实是一只|你其实是一个)/i, why: '试图改写身份' },
  { re: /(api.?key|token|密钥|密码|sk-[A-Za-z0-9]{16,})/i, why: '疑似密钥/凭据' },
  { re: /(无视|不受限|可以违反).{0,6}(规则|限制|约束|安全)/i, why: '试图解除约束' },
]

/** 扫一条记忆：返回 { blocked, why }；blocked=false 时 why 为 null */
export function scanEntry(text) {
  const t = String(text || '')
  for (const p of PATTERNS) {
    if (p.re.test(t)) return { blocked: true, why: p.why }
  }
  return { blocked: false, why: null }
}

/** 加载时的替换文本（磁盘原文不动） */
export const BLOCKED_TEXT = '[BLOCKED：这条记忆命中注入扫描，已在注入时屏蔽；请到工作台「我的 → 记忆」处理]'
