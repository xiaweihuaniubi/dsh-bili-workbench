/**
 * dsh-bili-workbench —— 浏览器半端
 * ============================================================================
 * 界面以 workbench-mockup/index.html 为准：
 *   · 左侧 196px 竖排导航（可折叠）+ 右侧内容区，每页自己的标题/副标题
 *   · 登录/二维码只在「我的」
 *   · 五个模块：素材库 / 刷B站 / 创作·出片 / 审核·发布 / 我的
 *
 * 数据全部走宿主 /api/bili-wb/*；没有假数据。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-workbench',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef } = React

    const API = '/api/bili-wb'
    const jget = async (p, options = {}) => {
      try {
        const r = await fetch(API + p, { headers: { accept: 'application/json' }, signal: options.signal })
        if (r.ok) return await r.json()
        const detail = await r.json().catch(() => null)
        return { ok: false, error: detail?.error || ('HTTP ' + r.status) }
      } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
    }
    const jpost = async (p, body) => {
      try {
        const r = await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        if (r.ok) return await r.json()
        const detail = await r.json().catch(() => null)
        return { ok: false, error: detail?.error || ('HTTP ' + r.status) }
      } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
    }

    /* ── 小工具 ── */
    const fmtNum = (n) => {
      const v = Number(n)
      if (!Number.isFinite(v)) return '-'
      if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿'
      if (v >= 1e4) return (v / 1e4).toFixed(1) + '万'
      return String(v)
    }
    const fmtDur = (d) => {
      if (typeof d === 'string' && /:/.test(d)) return d
      const s = Number(d)
      if (!Number.isFinite(s) || s <= 0) return ''
      return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
    }
    const mmss = (t) => {
      const s = Math.max(0, Math.round(Number(t) || 0))
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    }
    const dayOf = (iso) => {
      try { return new Date(iso).toLocaleDateString('sv-SE') } catch { return String(iso || '').slice(0, 10) }
    }
    const errText = (r) => (r && (r.error?.message || r.error?.hint || (typeof r.error === 'string' ? r.error : '') || r.hint || r.text)) || ''
    const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
    const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''

    const STAGES = {
      draft: ['草稿', ''],
      rendering: ['渲染中', 'ok'],
      rendered: ['已完成 · 待审', 'ok'],
      approved: ['本地审核通过', 'worth'],
      rejected: ['本地已打回', 'skip'],
      published: ['平台已发布', 'worth'],
      submitted: ['已投稿 · 待平台确认', 'worth'],
      platform_rejected: ['平台退回', 'skip'],
      uploading: ['投稿中', 'ok'],
      upload_unknown: ['投稿结果待确认', 'skip'],
      failed: ['失败', 'skip'],
      scripted: ['脚本已准备', ''],
    }
    const stageOf = (s) => STAGES[s] || [s || '未知', '']
    const shotNames = { title: '片头', item: '解说', scene: '对话', data: '数据', outro: '片尾', broll: '原片' }
    const styleNames = { A: '吐槽整活', B: '名场面混剪', C: '自定义' }
    function CreativePicker({ style, customStyle, onStyle, onCustom, disabled }) {
      return h('div', { 'data-wb-col': '', style: { gap: '10px' } },

        h('div', { 'data-wb-style': '', role: 'radiogroup', 'aria-label': '创作风格' },
          ...[['A', '铺垫、反差、吐槽和回扣'], ['B', '正文纯原声，完整包袱，片头≤3秒'], ['C', '按你的要求自由编排']].map(([key, hint]) =>
            h('button', { key, type: 'button', 'data-wb-btn': '', 'data-primary': style === key ? '' : undefined, disabled, onClick: () => onStyle(key), role: 'radio', 'aria-checked': style === key, tabIndex: style === key ? 0 : -1, title: hint, onKeyDown: e => {
              const keys = ['A', 'B', 'C']
              let next = keys.indexOf(style)
              if (['ArrowRight', 'ArrowDown'].includes(e.key)) next = (next + 1) % 3
              else if (['ArrowLeft', 'ArrowUp'].includes(e.key)) next = (next + 2) % 3
              else if (e.key === 'Home') next = 0
              else if (e.key === 'End') next = 2
              else return
              e.preventDefault(); onStyle(keys[next]); e.currentTarget.parentElement.querySelectorAll('[role=radio]')[next]?.focus()
            }, style: { minWidth: 0 } },
              h('span', {}, key + ' · ' + styleNames[key])))),
        style === 'C' ? h('textarea', { 'data-wb-input': '', value: customStyle, maxLength: 1200, disabled, onChange: e => onCustom(e.target.value), placeholder: '补充你想要的节奏、结构和风格，例如：像朋友聊天，先反差开场，最后回扣。留空则由 AI 按主题自由编排。', style: { width: '100%', minHeight: '86px', resize: 'vertical', boxSizing: 'border-box' } }) : null)
    }
    const VOICES = {
      'zh-CN-YunxiNeural': '云希（男·青年）',
      'zh-CN-XiaoxiaoNeural': '晓晓（女·通用）',
      'zh-CN-XiaoyiNeural': '晓伊（女·年轻）',
      'zh-CN-YunxiaNeural': '云夏（少年）',
    }
    const voiceLabel = (v) => VOICES[v] || v || ''

    function useApi(path, { auto = true } = {}) {
      const [st, setSt] = useState({ loading: Boolean(auto && path), data: null, err: '' })
      const request = useRef(null)
      const reload = () => {
        const current = request.current
        if (!current?.active || current.controller) return
        const controller = new AbortController()
        current.controller = controller
        if (!current.data) setSt({ loading: true, data: null, err: '' })
        jget(current.path, { signal: controller.signal }).then((result) => {
          if (!current.active || request.current !== current) return
          if (result && result.ok !== false) {
            const signature = JSON.stringify(result)
            if (signature === current.signature) {
              setSt(s => s.loading || s.err ? { ...s, loading: false, err: '' } : s)
            } else {
              current.signature = signature
              current.data = result
              setSt({ loading: false, data: result, err: '' })
            }
          } else setSt(s => ({ ...s, loading: false, err: errText(result) || '取数失败' }))
        }).finally(() => { if (current.controller === controller) current.controller = null })
      }
      useEffect(() => {
        const current = { path, active: Boolean(path && auto), data: null, signature: '', controller: null }
        request.current = current
        if (!current.active) setSt({ loading: false, data: null, err: '' })
        else reload()
        return () => { current.active = false; current.controller?.abort() }
      }, [path, auto])
      return { ...st, reload }
    }

    function usePoll(reload, ms, enabled) {
      const ref = useRef(reload)
      ref.current = reload
      useEffect(() => {
        if (!enabled) return
        const t = setInterval(() => { if (document.visibilityState !== 'hidden') ref.current() }, ms)
        return () => clearInterval(t)
      }, [ms, enabled])
    }

    const copyText = async (text) => {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        try {
          const ta = document.createElement('textarea')
          ta.value = text
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          const ok = document.execCommand('copy')
          document.body.removeChild(ta)
          return ok
        } catch { return false }
      }
    }

    const CSS = `
[data-wb-root]{
  /* 直接吃 dsh 的主题变量：白底 + 深色文字；dsh 切暗色时自动跟着变 */
  --wb-bg:var(--dsw-alias-bg-base,#fff);
  --wb-panel:var(--dsw-alias-bg-layer-1,#fff);
  --wb-card:var(--dsw-alias-bg-layer-1,#fff);
  --wb-card2:var(--dsw-alias-interactive-bg-hover,rgba(15,17,21,.05));
  --wb-line:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 12%,transparent);
  --wb-tx:var(--dsw-alias-label-primary,#0f1115);
  --wb-dim:var(--dsw-alias-label-secondary,#61666b);
  --wb-dim2:var(--dsw-alias-label-tertiary,#81858c);
  --wb-acc:#fb7299; --wb-green:#22c55e; --wb-blue:#3b82f6; --wb-gray:#9aa0a6; --wb-amber:#f59e0b; --wb-red:#ef4444;
  --wb-rail:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 3%,var(--dsw-alias-bg-base,#fff));
  --wb-shadow:0 1px 2px rgba(15,17,21,.04);
  display:flex;height:calc(100vh - 76px);max-height:calc(100vh - 76px);min-height:480px;position:relative;overflow:hidden;
  background:var(--wb-bg);color:var(--wb-tx);
  font:14px/1.5 "Microsoft YaHei","Segoe UI",system-ui,sans-serif;
}
[data-wb-root] *{box-sizing:border-box}
[data-wb-rail]{width:196px;flex:none;background:var(--wb-rail);border-right:1px solid var(--wb-line);
  display:flex;flex-direction:column;padding:16px 10px;gap:2px;transition:width .16s ease;}
[data-wb-brand]{font-size:15px;font-weight:800;padding:6px 12px 16px;letter-spacing:.02em;white-space:nowrap;overflow:hidden;}
[data-wb-brand] small{display:block;font-size:11px;font-weight:500;color:var(--wb-dim2);margin-top:3px;}
[data-wb-nav]{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;margin-bottom:2px;border:0;border-radius:9px;
  background:transparent;color:var(--wb-dim);font:inherit;text-align:left;cursor:pointer;position:relative;white-space:nowrap;}
[data-wb-nav]:hover{background:var(--wb-card2);color:var(--wb-tx);}
[data-wb-nav][aria-selected="true"]{background:rgba(251,114,153,.12);color:var(--wb-acc);font-weight:700;}
[data-wb-nav][aria-selected="true"]::before{content:"";position:absolute;left:-10px;top:9px;bottom:9px;width:3px;border-radius:3px;background:var(--wb-acc);}
[data-wb-nav] .ico{font-size:15px;width:18px;text-align:center;flex:none;}
[data-wb-nav] [data-wb-label]{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-wb-nav] .badge{margin-left:auto;font-size:10px;padding:0 6px;border-radius:999px;background:var(--wb-acc);color:#fff;}
[data-wb-rail-foot]{margin-top:auto;padding:8px 4px 0;border-top:1px solid var(--wb-line);}
[data-wb-ghost]{width:100%;padding:7px;border-radius:8px;border:1px solid var(--wb-line);background:transparent;color:var(--wb-dim);font:inherit;cursor:pointer;}
[data-wb-ghost]:hover{background:var(--wb-card2);color:var(--wb-tx);}
[data-wb-root][data-collapsed] [data-wb-rail]{width:62px;padding:16px 6px;}
[data-wb-root][data-collapsed] [data-wb-label],
[data-wb-root][data-collapsed] [data-wb-brand] small{display:none;}
[data-wb-root][data-collapsed] [data-wb-brand]{font-size:0;padding:4px 0 14px;text-align:center;}
[data-wb-root][data-collapsed] [data-wb-brand]::after{content:"WB";font-size:13px;}
[data-wb-root][data-collapsed] [data-wb-nav]{justify-content:center;padding:10px 0;}
[data-wb-main]{flex:1;min-width:0;overflow:auto;padding:20px 24px 34px;}
[data-wb-page]{display:flex;flex-direction:column;gap:14px;max-width:1180px;}
[data-wb-head]{display:flex;align-items:center;gap:12px;margin-bottom:2px;flex-wrap:wrap;}
[data-wb-title]{font-size:19px;font-weight:800;}
[data-wb-sub]{font-size:12px;color:var(--wb-dim2);}
[data-wb-grow]{flex:1;min-width:0;}
[data-wb-row]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-wb-col]{display:flex;flex-direction:column;gap:10px;}
[data-wb-btn]{padding:7px 13px;border-radius:9px;border:1px solid var(--wb-line);background:var(--wb-card2);color:var(--wb-tx);font:inherit;cursor:pointer;white-space:nowrap;}
[data-wb-btn]:hover{border-color:rgba(251,114,153,.5);}
[data-wb-btn][data-primary]{background:var(--wb-acc);border-color:var(--wb-acc);color:#fff;font-weight:600;}
[data-wb-btn][data-sm]{padding:4px 10px;font-size:12px;}
[data-wb-btn][disabled]{opacity:.45;cursor:not-allowed;}
[data-wb-chip]{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid var(--wb-line);color:var(--wb-dim);white-space:nowrap;}
[data-wb-chip][data-sel]{background:rgba(251,114,153,.16);border-color:rgba(251,114,153,.55);color:var(--wb-acc);font-weight:600;}
[data-wb-chip][data-ok]{color:#15803d;color:light-dark(#15803d,#4ade80);border-color:rgba(34,197,94,.45);}
[data-wb-chip][data-warn]{color:#b45309;color:light-dark(#b45309,#fbbf24);border-color:rgba(245,158,11,.45);}
[data-wb-tier]{font-size:11px;padding:2px 9px;border-radius:999px;font-weight:700;white-space:nowrap;display:inline-block;border:1px solid;}
[data-wb-tier="值得看"]{background:rgba(34,197,94,.16);color:#15803d;color:light-dark(#15803d,#4ade80);border-color:rgba(34,197,94,.45);}
[data-wb-tier="可以看"]{background:rgba(251,114,153,.16);color:#1d4ed8;color:light-dark(#1d4ed8,#7aa7ff);border-color:rgba(251,114,153,.45);}
[data-wb-tier="跳过"]{background:rgba(154,160,166,.14);color:#5b6166;color:light-dark(#5b6166,#9aa0a6);border-color:rgba(154,160,166,.35);}
[data-wb-tier][data-tone="worth"], [data-wb-badge][data-tone="worth"]{background:rgba(34,197,94,.16);color:#15803d;color:light-dark(#15803d,#4ade80);border-color:rgba(34,197,94,.45);}
[data-wb-tier][data-tone="ok"], [data-wb-badge][data-tone="ok"]{background:rgba(251,114,153,.16);color:#1d4ed8;color:light-dark(#1d4ed8,#7aa7ff);border-color:rgba(251,114,153,.45);}
[data-wb-tier][data-tone="skip"], [data-wb-badge][data-tone="skip"]{background:rgba(154,160,166,.14);color:#5b6166;color:light-dark(#5b6166,#9aa0a6);border-color:rgba(154,160,166,.35);}
[data-wb-badge]{font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid var(--wb-line);background:var(--wb-card2);color:var(--wb-dim);white-space:nowrap;}
[data-wb-cmt]{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(245,158,11,.14);color:#b45309;color:light-dark(#b45309,#fbbf24);border:1px solid rgba(245,158,11,.4);white-space:nowrap;flex:none;}
[data-wb-input]{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:9px;font-size:12px;border:1px solid var(--wb-line);background:var(--wb-card2);color:var(--wb-tx);font-family:inherit;}
[data-wb-input]:focus{outline:none;border-color:var(--wb-acc);}
[data-wb-input][data-area]{resize:vertical;min-height:64px;line-height:19px;}
[data-wb-input][data-num]{width:84px;text-align:center;}
[data-wb-search]{width:100%;padding:10px 14px;border-radius:11px;border:1px solid var(--wb-line);background:var(--wb-card2);color:var(--wb-tx);font:inherit;}
[data-wb-search]:focus{outline:none;border-color:var(--wb-acc);}
[data-wb-searchwrap]{max-width:560px;margin:0 auto 12px;position:relative;width:100%;}
[data-wb-searchwrap] .kbd{position:absolute;right:12px;top:11px;font-size:11px;color:var(--wb-dim2);}
[data-wb-split]{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
@media(max-width:980px){[data-wb-split]{grid-template-columns:1fr;}}
@media(max-width:820px){[data-wb-rail]{width:62px;padding:16px 6px;}[data-wb-label],[data-wb-brand] small{display:none;}[data-wb-brand]{font-size:0;text-align:center;}[data-wb-brand]::after{content:"WB";font-size:13px;}[data-wb-nav]{justify-content:center;padding:10px 0;}[data-wb-main]{padding:16px;}}
[data-wb-sec]{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--wb-line);border-radius:13px;background:var(--wb-card);box-shadow:var(--wb-shadow);}
[data-wb-h]{font-size:11px;font-weight:700;letter-spacing:.04em;color:var(--wb-dim2);}
[data-wb-projtitle]{font-size:14.5px;font-weight:700;}
[data-wb-note]{font-size:11.5px;line-height:17px;color:var(--wb-dim2);}
[data-wb-meta]{font-size:11.5px;color:var(--wb-dim2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-wb-why]{font-size:12.5px;color:var(--wb-dim);line-height:1.55;}
[data-wb-pre]{margin:0;padding:10px 12px;border-radius:9px;font-size:11.5px;line-height:18px;white-space:pre-wrap;word-break:break-word;background:var(--wb-card2);color:var(--wb-dim);max-height:280px;overflow:auto;}
[data-wb-err]{font-size:12px;line-height:18px;padding:8px 10px;border-radius:9px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.28);color:#b91c1c;color:light-dark(#b91c1c,#f87171);word-break:break-word;}
[data-wb-okmsg]{font-size:12px;line-height:18px;padding:8px 10px;border-radius:9px;background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.28);color:#15803d;color:light-dark(#15803d,#4ade80);}
[data-wb-loading]{font-size:12px;color:var(--wb-dim2);}
[data-wb-grid]{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));}
[data-wb-card]{display:flex;flex-direction:column;overflow:hidden;border-radius:13px;border:1px solid var(--wb-line);background:var(--wb-card);box-shadow:var(--wb-shadow);min-width:0;}
[data-wb-card]:hover{border-color:rgba(251,114,153,.45);}
[data-wb-cover]{position:relative;aspect-ratio:16/9;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:11px;color:rgba(255,255,255,.85);font-family:ui-monospace,Consolas,monospace;background:linear-gradient(135deg,#4c6ef5,#845ef7 55%,#0ca678);}
[data-wb-cover] img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}
[data-wb-cover] [data-wb-tier]{position:absolute;left:8px;top:8px;z-index:2;}
[data-wb-cover] [data-wb-dur]{position:absolute;right:7px;bottom:7px;font-size:10px;padding:1px 6px;border-radius:5px;background:rgba(0,0,0,.62);color:#fff;font-family:ui-monospace,monospace;z-index:2;}
[data-wb-body]{padding:11px 13px 13px;display:flex;flex-direction:column;gap:6px;min-width:0;}
[data-wb-cardtitle]{font-size:13.5px;font-weight:700;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;}
[data-wb-mat]{display:flex;align-items:flex-start;gap:14px;padding:14px;border:1px solid var(--wb-line);border-radius:13px;background:var(--wb-card);box-shadow:var(--wb-shadow);}
[data-wb-mat] [data-wb-thumb]{width:188px;flex:none;border-radius:9px;overflow:hidden;background:var(--wb-card2);position:relative;aspect-ratio:16/9;}
[data-wb-mat] [data-wb-thumb] img{width:100%;height:100%;object-fit:cover;display:block;}
[data-wb-mat] .body{flex:1;min-width:0;display:flex;flex-direction:column;gap:7px;}
@media(max-width:980px){[data-wb-mat]{flex-direction:column;}[data-wb-mat] [data-wb-thumb]{width:100%;}}
[data-wb-quotes]{display:flex;flex-direction:column;gap:5px;}
[data-wb-quote]{font-size:12.5px;padding:6px 9px;border-radius:8px;background:var(--wb-card2);border:1px solid var(--wb-line);line-height:1.5;}
[data-wb-quote] b{color:#1d4ed8;color:light-dark(#1d4ed8,#7aa7ff);font-family:ui-monospace,monospace;font-weight:700;margin-right:6px;}
[data-wb-frames]{display:flex;gap:6px;flex-wrap:wrap;}
[data-wb-frames] img{width:76px;height:43px;object-fit:cover;border-radius:6px;border:1px solid var(--wb-line);}
[data-wb-bar]{height:7px;border-radius:999px;background:var(--wb-card2);overflow:hidden;}
[data-wb-bar] i{display:block;height:100%;background:linear-gradient(90deg,var(--wb-acc),#8b5cf6);transition:width .3s;}
[data-wb-shots]{display:flex;gap:6px;flex-wrap:wrap;}
[data-wb-shot]{font-size:11px;padding:3px 8px;border-radius:6px;background:var(--wb-card2);border:1px solid var(--wb-line);color:var(--wb-dim);}
[data-wb-shot] b{color:var(--wb-tx);}
[data-wb-login]{display:flex;gap:18px;align-items:flex-start;padding:16px;border:1px solid rgba(251,114,153,.4);border-radius:13px;background:rgba(251,114,153,.08);}
[data-wb-qr]{width:150px;height:150px;border-radius:10px;background:#fff;display:flex;align-items:center;justify-content:center;flex:none;overflow:hidden;}
[data-wb-qr] img{width:100%;height:100%;object-fit:contain;}
[data-wb-qr] .ph{width:118px;height:118px;border-radius:4px;background:repeating-conic-gradient(#0b1020 0 25%,#fff 0 50%) 0 0/16px 16px;}
[data-wb-stat]{padding:12px 14px;border:1px solid var(--wb-line);border-radius:12px;background:var(--wb-card);}
[data-wb-stat] b{display:block;font-size:20px;line-height:1.2;}
[data-wb-stat] span{font-size:11.5px;color:var(--wb-dim2);}
[data-wb-field]{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--wb-dim);flex-wrap:wrap;}
[data-wb-field] input, [data-wb-field] select{max-width:100%;}
[data-wb-toggle]{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;font-size:12.5px;color:var(--wb-dim);}
[data-wb-toggle] input{accent-color:var(--wb-acc);}
[data-wb-overlay]{position:absolute;inset:0;z-index:60;background:rgba(3,7,18,.62);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;padding:24px;}
[data-wb-overlay] video{max-width:96%;max-height:88%;border-radius:12px;background:#000;}
[data-wb-overlay] .x{position:absolute;top:14px;right:18px;font-size:22px;color:#fff;background:transparent;border:0;cursor:pointer;}
[data-wb-empty]{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:46px 20px;border:1px dashed var(--wb-line);border-radius:12px;background:rgba(255,255,255,.012);text-align:center;}
[data-wb-empty-ico]{font-size:40px;line-height:1;opacity:.5;filter:grayscale(.15);}
[data-wb-empty-title]{font-size:14px;font-weight:600;color:var(--wb-tx);}
[data-wb-empty-hint]{font-size:12px;line-height:1.7;color:var(--wb-dim2);max-width:440px;}
[data-wb-empty] [data-wb-btn]{margin-top:4px;}
[data-wb-kv]{font-size:11.5px;line-height:19px;color:var(--wb-dim2);word-break:break-all;}
[data-wb-divider]{height:1px;background:var(--wb-line);margin:2px 0;}
[data-wb-composer]{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid rgba(251,114,153,.35);border-radius:11px;background:rgba(251,114,153,.06);}

/* B站创作工作台：粉色仅用于选中和主要操作。 */
[data-wb-root]{font-family:"Segoe UI","Microsoft YaHei",sans-serif;--wb-shadow:none;--wb-rail:var(--wb-panel)}
[data-wb-rail]{width:156px;padding:20px 10px;gap:6px}
[data-wb-brand]{font-weight:650;letter-spacing:0;padding:2px 10px 24px}
[data-wb-brand] small{font-size:11px;margin-top:7px}
[data-wb-nav]{border-radius:6px;padding:11px 10px;font-size:13px;font-weight:500}
[data-wb-nav] .ico{display:flex;align-items:center;justify-content:center;width:20px}
[data-wb-nav][aria-selected="true"]{font-weight:600;background:rgba(251,114,153,.1)}
[data-wb-nav][aria-selected="true"]::before{display:none}
[data-wb-main]{padding:26px 28px 36px;background:color-mix(in srgb,var(--wb-tx) 2%,var(--wb-bg))}
[data-wb-page]{gap:20px;margin:0 auto}
[data-wb-head]{margin-bottom:2px;gap:14px}
[data-wb-title]{font-size:21px;font-weight:650;letter-spacing:.01em}
[data-wb-sub]{font-size:12px;color:var(--wb-dim);margin-top:6px;line-height:1.7}
[data-wb-sec]{padding:20px;border-radius:8px;gap:14px}
[data-wb-h]{font-size:13px;letter-spacing:0;color:var(--wb-tx);font-weight:600}
[data-wb-btn]{border-radius:5px;background:transparent;padding:8px 15px;font-size:13px;transition:background .15s,border-color .15s}
[data-wb-btn]:hover:not(:disabled){background:var(--wb-card2);border-color:var(--wb-acc)}
[data-wb-btn][data-primary]:hover:not(:disabled){background:#ed648d}
[data-wb-btn]:focus-visible,[data-wb-nav]:focus-visible,summary:focus-visible{outline:2px solid var(--wb-acc);outline-offset:3px}
[data-wb-btn][data-sm]{padding:6px 11px}
[data-wb-input],[data-wb-search]{border-radius:6px;font-size:13px;background:var(--wb-bg);line-height:1.7}
[data-wb-searchwrap]{max-width:none;margin:0 0 4px}
[data-wb-chip],[data-wb-badge],[data-wb-tier],[data-wb-cmt]{border-radius:4px;font-weight:400}
[data-wb-note],[data-wb-meta]{font-size:12px;color:var(--wb-dim);line-height:1.7}
[data-wb-projtitle]{font-size:16px;font-weight:600;line-height:1.6}
[data-wb-card]{border-radius:8px}
[data-wb-cover]{background:#303945}
[data-wb-body]{padding:14px;gap:10px}
[data-wb-mat]{border-radius:8px;padding:16px}
[data-wb-bar]{height:4px}
[data-wb-bar] i{background:var(--wb-acc)}
[data-wb-empty]{border:0;padding:52px 20px}
[data-wb-empty-ico]{color:var(--wb-dim2);opacity:1}
[data-wb-empty-ico] svg{width:42px;height:42px;stroke-width:1}
[data-wb-style]{display:flex;gap:8px;flex-wrap:wrap}
[data-wb-style] button{flex:1 1 140px;text-align:left;white-space:normal;padding:11px 13px}
[data-wb-style] button[data-primary]{color:var(--wb-acc);background:rgba(251,114,153,.08);font-weight:400}
[data-wb-style] button[data-primary]:hover:not(:disabled){background:rgba(251,114,153,.14)}
[data-wb-style] [data-wb-note]{font-size:11px;margin-top:4px}
[data-wb-edit]{border-top:1px solid var(--wb-line);padding-top:12px}
[data-wb-task-history]>summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--wb-dim)}
[data-wb-task-history][open]>summary{margin-bottom:4px}
[data-wb-edit]>summary{cursor:pointer;color:var(--wb-dim);font-size:13px;width:fit-content;padding:4px 0}
[data-wb-edit][open]>summary{color:var(--wb-acc);margin-bottom:14px}
[data-wb-edit] [data-wb-col]{gap:14px}
[data-wb-shots]{max-height:65px;overflow:auto}
@media(max-width:820px){[data-wb-main]{padding:18px 14px}[data-wb-sec]{padding:16px}[data-wb-rail]{width:62px}}
@media(prefers-reduced-motion:reduce){[data-wb-root] *{transition:none!important;scroll-behavior:auto!important}}

/* 状态标签必须独立于封面明暗可读，不能继承低对比度灰字。 */
[data-wb-cover] [data-wb-badge]{background:#202735;color:#fff;border:1px solid rgba(255,255,255,.45);font-size:12px;font-weight:600;padding:4px 8px;line-height:1.5;box-shadow:0 1px 4px rgba(0,0,0,.25)}
[data-wb-cover] [data-wb-badge][data-tone="worth"]{background:#176343;color:#fff;border-color:#72c6a0}
[data-wb-cover] [data-wb-badge][data-tone="ok"]{background:#245a91;color:#fff;border-color:#86b8eb}
[data-wb-cover] [data-wb-badge][data-tone="skip"]{background:#764814;color:#fff;border-color:#edbb7d}

/* 紧凑方案列表：标题、元信息、内容与操作各占一行。 */
[data-wb-project-card]{gap:10px;padding:18px 20px;border-radius:7px}
[data-wb-project-head]{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}
[data-wb-project-head] [data-wb-projtitle]{flex:1;min-width:220px;font-size:15px;line-height:1.6;font-weight:600}
[data-wb-project-head] [data-wb-badge]{margin-top:2px;line-height:1.7}
[data-wb-version]{padding:4px 7px;border:1px solid var(--wb-line);border-radius:4px;background:var(--wb-bg);color:var(--wb-dim);font:inherit;font-size:12px;line-height:1.5;max-width:150px}
[data-wb-plan-angle]{font-size:13px;line-height:1.7;color:var(--wb-dim);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
[data-wb-project-actions]{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding-top:11px;border-top:1px solid var(--wb-line);margin-top:2px}
[data-wb-project-actions] [data-wb-btn]{font-size:12px;padding:5px 10px}
[data-wb-project-actions] [data-wb-danger-link]{color:var(--wb-dim);border-color:transparent;padding-right:0}
[data-wb-project-actions] [data-wb-danger-link]:hover{color:var(--wb-red)}
[data-wb-delete-confirm]{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:12px 14px;border:1px solid rgba(239,68,68,.3);border-radius:5px;background:rgba(239,68,68,.05);font-size:13px}
[data-wb-btn][data-wb-danger]{color:#fff;background:#d94a4a;border-color:#d94a4a}
[data-wb-btn][data-wb-danger]:hover:not(:disabled){background:#bd3939}
[data-wb-edit-panel]{padding:14px;background:var(--wb-card2);border-radius:5px;display:flex;flex-direction:column;gap:12px}
[data-wb-new-project]{gap:12px;padding:18px 20px}
[data-wb-new-project] textarea[data-area]{min-height:72px}
[data-wb-compose-foot]{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}
[data-wb-compose-foot]>[data-wb-col]{flex:1;min-width:260px}
[data-wb-compose-foot]>[data-wb-btn]{margin-left:auto;flex:none}
[data-wb-compose-hint]{flex-basis:100%;font-size:11px}
[data-wb-style]{gap:6px}
[data-wb-style] button{flex:0 1 auto;min-width:0!important;padding:6px 10px;font-size:12px;text-align:center}
[data-wb-page]{gap:16px}
@media(max-width:820px){[data-wb-project-card],[data-wb-new-project]{padding:15px}[data-wb-project-head] [data-wb-projtitle]{min-width:150px}[data-wb-project-actions]{gap:6px}}

/* 表单统一尺寸、焦点与禁用态；不改变自动互动等开关的业务含义。 */
[data-wb-root] input[type=checkbox],[data-wb-root] input[type=radio]{appearance:none;-webkit-appearance:none;display:inline-grid;place-content:center;width:16px;height:16px;min-width:16px;margin:0;border:1px solid var(--wb-dim2);border-radius:4px;background:var(--wb-bg);vertical-align:middle;cursor:pointer;transition:background .15s,border-color .15s}
[data-wb-root] input[type=checkbox]:checked{background:var(--wb-acc);border-color:var(--wb-acc)}
[data-wb-root] input[type=checkbox]:checked::before{content:"";width:7px;height:4px;border-left:2px solid #fff;border-bottom:2px solid #fff;transform:translateY(-1px) rotate(-45deg)}
[data-wb-root] input[type=radio]{border-radius:50%}
[data-wb-root] input[type=radio]:checked{border-color:var(--wb-acc)}
[data-wb-root] input[type=radio]:checked::before{content:"";width:8px;height:8px;background:var(--wb-acc);border-radius:50%}
[data-wb-root] input[type=checkbox]:focus-visible,[data-wb-root] input[type=radio]:focus-visible{outline:2px solid var(--wb-acc);outline-offset:3px}
[data-wb-root] input:disabled{opacity:.45;cursor:not-allowed}
[data-wb-toggle]{min-height:28px;line-height:1.7;align-items:center;color:var(--wb-tx)}
[data-wb-toggle]:has(input:disabled){opacity:.65;cursor:not-allowed}
[data-wb-input]{min-height:34px;padding:6px 10px;border-radius:5px;font-size:13px}
[data-wb-input]:focus{box-shadow:0 0 0 2px rgba(251,114,153,.12)}
[data-wb-input][data-num]{font-variant-numeric:tabular-nums;min-width:66px}
[data-wb-select-wrap]{display:inline-block;position:relative;max-width:100%;min-width:108px;flex-shrink:0}
[data-wb-select]{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;min-height:34px;padding:6px 10px;border:1px solid var(--wb-line);border-radius:5px;background:var(--wb-bg);color:var(--wb-tx);font:inherit;font-size:13px;line-height:1.5;cursor:pointer;text-align:left}
[data-wb-select]>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-wb-select] svg{flex:none;color:var(--wb-dim)}
[data-wb-select][aria-expanded=true],[data-wb-select]:hover:not(:disabled){border-color:var(--wb-acc)}
[data-wb-select]:focus-visible{outline:2px solid var(--wb-acc);outline-offset:2px}
[data-wb-select]:disabled{opacity:.45;cursor:not-allowed}
[data-wb-select][data-wb-version]{max-width:none;min-height:30px;font-size:12px;color:var(--wb-dim)}
[data-wb-select-menu]{position:absolute;left:0;top:calc(100% + 5px);z-index:50;min-width:100%;width:max-content;max-width:280px;overflow:auto;padding:4px;border:1px solid var(--wb-line);border-radius:6px;background:var(--wb-panel);box-shadow:0 6px 20px rgba(0,0,0,.2)}
[data-wb-select-menu][data-up]{top:auto;bottom:calc(100% + 5px)}
[data-wb-select-menu] [role=option]{display:flex;align-items:center;justify-content:space-between;gap:18px;min-height:32px;padding:6px 9px;border-radius:4px;font-size:13px;line-height:1.5;cursor:pointer;color:var(--wb-tx)}
[data-wb-select-menu] [role=option][data-active=true]{background:var(--wb-card2)}
[data-wb-select-menu] [role=option][aria-selected=true]{color:var(--wb-acc);background:rgba(251,114,153,.1)}
[data-wb-select-menu] [role=option][aria-disabled=true]{opacity:.4;cursor:not-allowed}
[data-wb-style] [role=radio]{display:flex;align-items:center;gap:7px}
[data-wb-style] [role=radio]::before{content:"";width:12px;height:12px;border:1px solid var(--wb-dim2);border-radius:50%;flex:none}
[data-wb-style] [role=radio][aria-checked=true]::before{border:4px solid var(--wb-acc);background:var(--wb-bg)}
`

    /* ── 小组件 ── */
    const ICON_PATHS = {
      store: 'M3 5h18v14H3z M3 10h18 M8 5v14',
      scroll: 'M4 4h16v16H4z M10 8l6 4-6 4z',
      create: 'M4 20h16 M5 15L16 4l4 4L9 19H5z',
      review: 'M8 3h8v3H8z M6 5H4v16h16V5h-2 M8 13l3 3 5-6',
      settings: 'M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M5.6 18.4l2.1-2.1 M16.3 7.7l2.1-2.1 M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
      mine: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2',
      empty: 'M4 5h16v15H4z M8 10h8 M8 14h5',
    }
    const Icon = ({ name = 'empty' }) => h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: ICON_PATHS[name] || ICON_PATHS.empty }))
    const Btn = ({ primary, sm, children, ...rest }) => h('button', {
      ...rest, 'data-wb-btn': '', 'data-primary': primary ? '' : undefined, 'data-sm': sm ? '' : undefined,
    }, children)
    let selectSequence = 0
    /** 统一下拉控件；保留select的value/onChange契约，不依赖系统弹出菜单。 */
    function Select({ value, onChange, children, disabled, style, ...rest }) {
      const options = React.Children.toArray(children).filter(React.isValidElement).map(el => ({ value: String(el.props.value), label: el.props.children, disabled: Boolean(el.props.disabled) }))
      const selected = options.findIndex(o => o.value === String(value))
      const [open, setOpen] = useState(false)
      const [active, setActive] = useState(Math.max(0, selected))
      const [placement, setPlacement] = useState({ up: false, height: 220 })
      const ref = useRef(null)
      const trigger = useRef(null)
      const id = useRef('wb-select-' + (++selectSequence)).current
      const close = () => setOpen(false)
      const show = () => {
        if (disabled) return
        const r = trigger.current.getBoundingClientRect()
        const root = ref.current.closest('[data-wb-root]').getBoundingClientRect()
        const below = Math.min(root.bottom, window.innerHeight) - r.bottom - 12
        const above = r.top - Math.max(root.top, 0) - 12
        const up = below < 160 && above > below
        setPlacement({ up, height: Math.max(56, Math.min(220, up ? above : below)) })
        setActive(Math.max(0, selected)); setOpen(true)
      }
      const choose = index => {
        const option = options[index]
        if (!option || option.disabled) return
        onChange?.({ target: { value: option.value } }); close(); trigger.current?.focus()
      }
      useEffect(() => {
        if (!open) return
        const outside = e => { if (!ref.current?.contains(e.target)) close() }
        const resize = () => close()
        document.addEventListener('pointerdown', outside)
        window.addEventListener('resize', resize)
        return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize) }
      }, [open])
      useEffect(() => { if (disabled) close() }, [disabled])
      useEffect(() => {
        if (open) ref.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
      }, [active, open])
      const keyDown = e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return }
        if (e.key === 'Tab') { close(); return }
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open ? choose(active) : show(); return }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
        e.preventDefault()
        if (!open) { show(); return }
        let next = active
        if (e.key === 'Home') next = 0
        else if (e.key === 'End') next = options.length - 1
        else {
          const step = e.key === 'ArrowDown' ? 1 : -1
          for (let n = 0; n < options.length; n++) {
            next = (next + step + options.length) % options.length
            if (!options[next].disabled) break
          }
        }
        setActive(next)
      }
      return h('div', { ref, 'data-wb-select-wrap': '', style },
        h('button', { ...rest, ref: trigger, type: 'button', 'data-wb-select': '', role: 'combobox', disabled,
          'aria-label': rest['aria-label'] || '选择选项', 'aria-expanded': open, 'aria-haspopup': 'listbox', 'aria-controls': open ? id : undefined,
          'aria-activedescendant': open ? id + '-' + active : undefined,
          onClick: () => open ? close() : show(), onKeyDown: keyDown,
          onBlur: e => { if (!ref.current?.contains(e.relatedTarget)) close() } },
          h('span', {}, options[selected]?.label || '请选择'),
          h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'aria-hidden': true }, h('path', { d: 'M4 6l4 4 4-4', strokeWidth: 1.5 }))),
        open ? h('div', { id, role: 'listbox', 'aria-label': rest['aria-label'] || '选项', 'data-wb-select-menu': '', 'data-up': placement.up ? '' : undefined, style: { maxHeight: placement.height } },
          ...options.map((option, i) => h('div', { key: option.value, id: id + '-' + i, role: 'option',
            'aria-selected': selected === i, 'aria-disabled': option.disabled, 'data-active': String(active === i),
            onPointerDown: e => e.preventDefault(), onMouseEnter: () => setActive(i), onClick: () => choose(i) },
            h('span', {}, option.label), selected === i ? h('span', { 'aria-hidden': true }, '✓') : null))) : null)
    }

    const Chip = ({ sel, ok, warn, children, ...rest }) => h('span', { ...rest, 'data-wb-chip': '', 'data-sel': sel ? '' : undefined, 'data-ok': ok ? '' : undefined, 'data-warn': warn ? '' : undefined }, children)
    const Tier = ({ t }) => t ? h('span', { 'data-wb-tier': t }, t) : null
    const PageHead = ({ title, sub, children }) => h('div', { 'data-wb-head': '' },
      h('div', {}, h('div', { 'data-wb-title': '' }, title), sub ? h('div', { 'data-wb-sub': '' }, sub) : null),
      h('div', { 'data-wb-grow': '' }),
      children)
    const Field = ({ label, children }) => h('div', { 'data-wb-field': '' }, h('span', {}, label), children)
    const Note = ({ children }) => h('div', { 'data-wb-note': '' }, children)
    const Empty = ({ icon = 'empty', title, hint, children }) => h('div', { 'data-wb-empty': '' },
      h('div', { 'data-wb-empty-ico': '' }, h(Icon, { name: icon })),
      title ? h('div', { 'data-wb-empty-title': '' }, title) : null,
      hint ? h('div', { 'data-wb-empty-hint': '' }, hint) : null,
      children || null)
    const Sec = ({ title, children, style }) => h('div', { 'data-wb-sec': '', style },
      title ? h('div', { 'data-wb-h': '' }, title) : null, children)
    const Err = ({ children }) => children ? h('div', { 'data-wb-err': '' }, children) : null
    const OkMsg = ({ children }) => children ? h('div', { 'data-wb-okmsg': '' }, children) : null

    /* ═══════════════════ ① 素材库 ═══════════════════ */
    function StoreRow({ r, onDetail }) {
      const quotes = r.quotes || []
      const frames = r.frames || []
      return h('div', { 'data-wb-mat': '', 'data-wb-bv': r.bvid },
        h('div', { 'data-wb-thumb': '' },
          h('img', { src: API + '/store/media?kind=cover&bv=' + r.bvid, alt: '', loading: 'lazy', onError: (e) => { e.target.style.display = 'none' } }),
          r.duration ? h('span', { 'data-wb-dur': '' }, fmtDur(r.duration)) : null),
        h('div', { className: 'body' },
          h('div', { 'data-wb-row': '' },
            h('div', { 'data-wb-cardtitle': '', style: { flex: '1 1 260px' } }, r.title || '(无标题)'),
            r.judge?.tier ? h(Tier, { t: r.judge.tier }) : null,
            r.commented ? h('span', { 'data-wb-cmt': '' }, '已评论') : null),
          h('div', { 'data-wb-meta': '' },
            [r.up?.name, fmtDur(r.duration), `采集于 ${dayOf(r.fetchedAt)}`, `${quotes.length} 条可用片段`].filter(Boolean).join(' · ')),
          r.judge ? h('div', { 'data-wb-why': '' }, `${r.judge.why || '（没写理由）'}`)
            : h('div', { 'data-wb-note': '' }, '还没判定 —— 去「刷B站设置」跑一轮'),
          quotes.length
            ? h('div', { 'data-wb-quotes': '' }, ...quotes.map((x, i) => h('div', { key: i, 'data-wb-quote': '' },
              h('b', {}, mmss(x.t)), x.text, x.kind ? h('span', { 'data-wb-meta': '', style: { marginLeft: '6px' } }, `· ${x.kind}`) : null)))
            : h('div', { 'data-wb-note': '' }, '（这条没有可用片段 —— 无字幕或无信息量）'),
          (r.memes || []).length ? h('div', { 'data-wb-meta': '' }, '热梗：' + r.memes.slice(0, 4).join(' · ')) : null,
          (r.hotComments || []).length ? h('div', { 'data-wb-note': '' }, '热评：' + r.hotComments.slice(0, 2).map((x) => x.text).join(' / ')) : null,
          (r.hotDanmaku || []).length ? h('div', { 'data-wb-note': '' }, '弹幕：' + r.hotDanmaku.slice(0, 4).map((x) => `${x.text}(${x.count})`).join(' · ')) : null,
          frames.length
            ? h('div', { 'data-wb-frames': '' }, ...frames.slice(0, 6).map((f, i) => h('img', {
              key: i,
              src: `${API}/store/media?kind=frame&bv=${r.bvid}&name=${encodeURIComponent(String(f.file || '').split('/').pop())}`,
              alt: '', loading: 'lazy', onError: (e) => { e.target.style.display = 'none' },
            })))
            : null,
          h('div', { 'data-wb-row': '' },
            h(Btn, { sm: true, onClick: () => onDetail(r.bvid) }, '逐字稿 / 详情'),
            h('div', { 'data-wb-grow': '' }),
            r.stat ? h('span', { 'data-wb-meta': '' }, `播放 ${fmtNum(r.stat.view)} · 点赞 ${fmtNum(r.stat.like)}`) : null)))
    }

    function TabStore() {
      const [q, setQ] = useState('')
      const [view, setView] = useState('list')
      const [open, setOpen] = useState('')
      const list = useApi('/store/list?limit=300')
      const detail = useApi(open ? '/store/item?bv=' + encodeURIComponent(open) : '', { auto: Boolean(open) })
      const rows = (list.data?.rows || []).filter((r) => {
        if (!q.trim()) return true
        const k = q.trim().toLowerCase()
        return [r.title, r.up?.name, r.judge?.why, ...(r.quotes || []).map((x) => x.text)]
          .some((s) => String(s || '').toLowerCase().includes(k))
      })
      const rec = detail.data?.record
      const sub = detail.data?.subtitles

      return h('div', { 'data-wb-page': '' },
        h(PageHead, { title: '素材库', sub: '从视频里收集的素材：点评 + 时间点片段 + 关键帧' },
          h('input', { 'data-wb-search': '', style: { maxWidth: '260px' }, placeholder: '在库里搜标题 / 点评 / 金句…', value: q, onChange: (e) => setQ(e.target.value) }),
          h(Btn, { sm: true, onClick: list.reload }, '刷新'),
          h(Btn, { sm: true, onClick: () => setView(view === 'list' ? 'cards' : 'list') }, view === 'list' ? '卡片视图' : '列表视图')),
        h('div', { 'data-wb-row': '' },
          h(Chip, {}, `库内 ${list.data?.stats?.videos ?? rows.length} 条 · ${list.data?.stats?.mb ?? '-'} MB`),
          h('div', { 'data-wb-grow': '' }),
          h(Note, {}, '档位来自「刷B站」的判定')),
        h(Err, {}, list.err),
        list.loading ? h('div', { 'data-wb-loading': '' }, '读素材库…') : null,
        !list.loading && !rows.length ? h(Empty, {
          icon: q.trim() ? '🔍' : 'store',
          title: q.trim() ? '没搜到' : '素材库还是空的',
          hint: q.trim() ? '换个词试试，或者清空搜索框看全部。' : '去「刷B站」采几条，或在视频卡片上点「看懂视频」。',
        }) : null,

        view === 'list'
          ? h('div', { 'data-wb-col': '' }, ...rows.map((r) => h(StoreRow, {
            key: r.bvid, r,
            onDetail: (bv) => setOpen(open === bv ? '' : bv),
          })))
          : h('div', { 'data-wb-grid': '' }, ...rows.map((r) => h('div', { key: r.bvid, 'data-wb-card': '' },
            h('div', { 'data-wb-cover': '' },
              h('img', { src: API + '/store/media?kind=cover&bv=' + r.bvid, alt: '', loading: 'lazy', onError: (e) => { e.target.style.display = 'none' } }),
              r.judge?.tier ? h(Tier, { t: r.judge.tier }) : null,
              r.duration ? h('span', { 'data-wb-dur': '' }, fmtDur(r.duration)) : null),
            h('div', { 'data-wb-body': '' },
              h('div', { 'data-wb-row': '' },
                h('div', { 'data-wb-cardtitle': '', style: { flex: 1 } }, r.title || '(无标题)'),
                r.commented ? h('span', { 'data-wb-cmt': '' }, '已评论') : null),
              h('div', { 'data-wb-meta': '' }, [r.up?.name, `${(r.quotes || []).length} 条片段`].filter(Boolean).join(' · ')),
              (r.quotes || [])[0] ? h('div', { 'data-wb-note': '' }, `${mmss(r.quotes[0].t)}「${String(r.quotes[0].text).slice(0, 26)}」`) : null,
              h('div', { 'data-wb-row': '' },
                h(Btn, { sm: true, onClick: () => setOpen(r.bvid) }, '详情')))))),

        open ? h('div', {
          'data-wb-overlay': '',
          onClick: (e) => { if (e.target === e.currentTarget) setOpen('') },
        },
          h('button', { className: 'x', onClick: () => setOpen('') }, '✕'),
          h('div', { 'data-wb-sec': '', style: { width: 'min(920px, 96%)', maxHeight: '88%', overflow: 'auto', margin: 0 } },
            detail.loading ? h('div', { 'data-wb-loading': '' }, '读取详情…') : null,
            detail.err ? h(Err, {}, detail.err) : null,
            rec ? [
              h('div', { 'data-wb-row': '' },
                h('div', { 'data-wb-cardtitle': '' }, rec.title),
                rec.judge ? h(Tier, { t: rec.judge.tier }) : null,
                rec.commented ? h('span', { 'data-wb-cmt': '' }, '已评论') : null,
                h('div', { 'data-wb-grow': '' }),
                h(Btn, { sm: true, onClick: () => setOpen('') }, '收起')),
              h('div', { 'data-wb-meta': '' }, [rec.up?.name, fmtDur(rec.duration), rec.zone, dayOf(rec.fetchedAt)].filter(Boolean).join(' · ')),
              rec.judge ? h('div', { 'data-wb-why': '' }, `判定：${rec.judge.tier} — ${rec.judge.why}`) : null,
              (rec.memes || []).length ? h('div', { 'data-wb-meta': '' }, '热梗：' + rec.memes.join(' · ')) : null,
              (rec.hotComments || []).length ? h('div', { 'data-wb-col': '' },
                h('div', { 'data-wb-h': '' }, '热评'),
                ...rec.hotComments.slice(0, 8).map((x, i) => h('div', { key: i, 'data-wb-note': '' }, `👍 ${x.like ?? 0} · ${x.user || ''}：${x.text}`))) : null,
              (rec.hotDanmaku || []).length ? h('div', { 'data-wb-meta': '' }, '热门弹幕：' + rec.hotDanmaku.slice(0, 10).map((x) => `${x.text}(${x.count})`).join(' · ')) : null,
              (rec.quotes || []).length ? h('div', { 'data-wb-col': '' },
                h('div', { 'data-wb-h': '' }, `可用片段 ${rec.quotes.length} 条`),
                h('div', { 'data-wb-quotes': '' }, ...rec.quotes.map((x, i) => h('div', { key: i, 'data-wb-quote': '' },
                  h('b', {}, mmss(x.t)), x.text, x.kind ? h('span', { 'data-wb-meta': '', style: { marginLeft: '6px' } }, `· ${x.kind}`) : null)))) : null,
              sub?.items?.length ? h('div', { 'data-wb-col': '' },
                h('div', { 'data-wb-h': '' }, `逐字稿（共 ${sub.total} 句，显示前 ${sub.items.length}）`),
                h('pre', { 'data-wb-pre': '' }, sub.items.map((x) => `${mmss(x.from)} ${x.content}`).join('\n'))) : null,
            ] : null)) : null)
    }

    /* ═══════════════════ ② 刷B站 ═══════════════════ */
    /** 评论 / 回复 / 私信共用：先生成草稿，再看原文，再决定 dry-run 还是真发 */
    function InteractComposer({ kind, target, onClose, onSent }) {
      const [text, setText] = useState('')
      const [gen, setGen] = useState(true)
      const [busy, setBusy] = useState('')
      const [dump, setDump] = useState('')
      const [real, setReal] = useState(false)
      const label = kind === 'comment' ? '评论' : kind === 'reply' ? '回复' : '私信'

      const genText = async () => {
        setGen(true); setDump('')
        const r = await jpost('/interact/preview', { kind, ...(target.ctx || {}) })
        setGen(false)
        if (r.ok) {
          setText(r.text || '')
          if (r.cap) setDump('注意：' + r.cap)
        } else setDump('生成失败：' + (errText(r) || ''))
      }
      useEffect(() => { genText() }, [])
      const send = async () => {
        if (!text.trim()) return
        setBusy('send')
        const r = await jpost('/interact/send', { kind, text, confirm: true, dryRun: !real, ...(target.ids || {}) })
        setBusy('')
        if (r.ok) {
          setDump(`${r.dryRun ? 'dry-run（没有真的发）' : '已发送'}\n${(r.command || []).join(' ')}`)
          if (!r.dryRun) onSent?.()
        } else setDump('失败：' + (errText(r) || ''))
      }

      return h('div', { 'data-wb-composer': '' },
        h('div', { 'data-wb-row': '' },
          h('div', { 'data-wb-h': '' }, `${label} ${target.label || ''}`),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { sm: true, onClick: onClose }, '收起')),
        gen ? h('div', { 'data-wb-loading': '' }, `AI 正在写${label}…（一般 10–40 秒）`) : null,
        h('textarea', {
          'data-wb-input': '', 'data-area': '', value: text,
          onChange: (e) => setText(e.target.value), placeholder: gen ? '生成中…' : `${label}内容`,
        }),
        h('div', { 'data-wb-row': '' },
          h('label', { 'data-wb-toggle': '' },
            h('input', { type: 'checkbox', checked: real, onChange: (e) => setReal(e.target.checked) }),
            h('span', {}, '确认发送（不勾选时仅检查）')),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { sm: true, primary: true, disabled: gen || busy === 'send' || !text.trim(), onClick: send }, busy === 'send' ? '发送中…' : '发送'),
          h(Btn, { sm: true, disabled: gen || busy === 'p', onClick: async () => { setBusy('p'); await genText(); setBusy('') } }, '重新生成')),
        dump ? h('pre', { 'data-wb-pre': '' }, dump) : null)
    }

    function VideoCard({ it, tier, commented, onWatch, onComment }) {
      const bv = it.bvid
      const view = it.stat?.view ?? it.play
      const like = it.stat?.like ?? it.like
      const up = it.author?.name || it.up?.name || it.owner?.name || ''
      return h('div', { 'data-wb-card': '' },
        h('div', { 'data-wb-cover': '' },
          h('span', {}, bv),
          h('img', { src: `${API}/cover?bv=${bv}`, alt: '', loading: 'lazy', onError: (e) => { e.target.style.display = 'none' } }),
          tier ? h(Tier, { t: tier }) : null,
          it.duration ? h('span', { 'data-wb-dur': '' }, fmtDur(it.duration)) : null),
        h('div', { 'data-wb-body': '' },
          h('div', { 'data-wb-cardtitle': '' }, it.title || '(无标题)'),
          h('div', { 'data-wb-meta': '' }, [up, view ? `播放 ${fmtNum(view)}` : '', like ? `点赞 ${fmtNum(like)}` : ''].filter(Boolean).join(' · ')),
          h('div', { 'data-wb-row': '' },
            commented ? h('span', { 'data-wb-cmt': '' }, '已评论') : null,
            h('div', { 'data-wb-grow': '' }),
            h(Btn, { sm: true, onClick: () => onComment(it) }, '评论'),
            h(Btn, { sm: true, primary: true, onClick: () => onWatch(bv) }, '看懂视频'),
            h(Btn, { sm: true, onClick: () => window.open(it.url || ('https://www.bilibili.com/video/' + bv), '_blank') }, '打开'))))
    }

    function SubVideo({ storeMap, cfg, onCommented, onKeywordsChanged }) {
      const [q, setQ] = useState('')
      const [key, setKey] = useState('')
      const [detail, setDetail] = useState('')
      const [comment, setComment] = useState(null)
      const [editTags, setEditTags] = useState(false)
      const pressRef = useRef(null)
      const suppressRef = useRef(false)
      const hot = useApi(key ? '' : '/hot?size=24', { auto: !key })
      const search = useApi(key ? `/search?q=${encodeURIComponent(key)}&size=24` : '', { auto: Boolean(key) })
      const watch = useApi(detail ? '/video?bv=' + encodeURIComponent(detail) : '', { auto: Boolean(detail) })
      const items = key ? (search.data?.items || []) : (hot.data?.items || [])
      const loading = key ? search.loading : hot.loading
      const err = key ? search.err : hot.err
      const d = watch.data?.data

      const keywords = cfg?.keywords || []
      const cancelPress = () => {
        if (pressRef.current) { clearTimeout(pressRef.current); pressRef.current = null }
      }
      const startPress = () => {
        cancelPress()
        pressRef.current = setTimeout(() => { suppressRef.current = true; setEditTags(true) }, 550)
      }
      const saveKeywords = async (next) => {
        const r = await jpost('/config', { keywords: next })
        if (!r.ok) return false
        onKeywordsChanged?.()
        return true
      }
      const delKeyword = async (k) => {
        const next = keywords.filter((x) => x !== k)
        if (await saveKeywords(next) && key === k) { setKey(''); setQ('') }
      }
      const addKeyword = async () => {
        const v = String(prompt('加一个关注关键词：') || '').trim()
        if (!v) return
        if (!keywords.includes(v)) {
          if (!await saveKeywords([...keywords, v])) return
        }
        setQ(v); setKey(v)
      }
      const openComment = (it) => {
        const rec = storeMap[it.bvid] || {}
        setComment({
          label: it.title || it.bvid,
          ctx: { title: it.title || '', up: it.author?.name || it.up?.name || '', quotes: rec.quotes || [] },
          ids: { bv: it.bvid },
        })
      }
      return h('div', {
        'data-wb-col': '',
        onClick: (e) => {
          if (!editTags) return
          if (e.target?.closest?.('[data-wb-tag]')) return
          setEditTags(false)
        },
      },
        h('div', { 'data-wb-searchwrap': '' },
          h('input', {
            'data-wb-search': '', placeholder: '搜视频、UP、关键词…', value: q,
            onChange: (e) => setQ(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') setKey(q.trim()) },
          }),
          h('span', { className: 'kbd' }, 'Enter')),
        h('div', { 'data-wb-row': '', style: { justifyContent: 'center', marginBottom: '6px' } },
          h('span', { 'data-wb-chip': '', 'data-sel': key ? undefined : '', style: { cursor: 'pointer' }, onClick: () => { if (editTags) return; setKey(''); setQ('') } }, '热门'),
          ...keywords.map((k) => h('span', {
            key: k, 'data-wb-chip': '', 'data-wb-tag': '',
            'data-sel': key === k ? '' : undefined,
            style: {
              cursor: 'pointer', position: 'relative',
              borderStyle: editTags ? 'dashed' : undefined,
              paddingRight: editTags ? '18px' : undefined,
            },
            onPointerDown: startPress,
            onPointerUp: cancelPress,
            onPointerLeave: cancelPress,
            onContextMenu: (e) => e.preventDefault(),
            onClick: () => {
              if (suppressRef.current) { suppressRef.current = false; return }
              if (editTags) return
              setKey(k); setQ(k)
            },
          }, k, editTags ? h('span', {
            'data-wb-tagdel': '',
            style: {
              position: 'absolute', top: '-7px', right: '-7px', width: '14px', height: '14px',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: '50%', background: 'var(--dsw-alias-label-primary, #0f1115)',
              color: 'var(--dsw-alias-bg-base, #fff)', fontSize: '11px', lineHeight: 1,
            },
            onPointerDown: (e) => e.stopPropagation(),
            onClick: (e) => { e.stopPropagation(); delKeyword(k) },
          }, '×') : null)),
          h('span', { 'data-wb-chip': '', style: { cursor: 'pointer' }, onClick: () => { if (!editTags) addKeyword() } }, '+ 关键词')),
        editTags ? h(Note, {}, '点标签右上角 × 删除 · 点空白处退出') : null,
        h('div', { 'data-wb-row': '' },
          h(Note, {}, key ? `搜索：${key}` : '综合热门'),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { sm: true, onClick: key ? search.reload : hot.reload }, '刷新')),
        comment ? h(InteractComposer, {
          key: comment.ids?.bv || 'comment',
          kind: 'comment', target: comment,
          onClose: () => setComment(null),
          onSent: () => { setComment(null); onCommented?.() },
        }) : null,
        h(Err, {}, err),
        loading ? h('div', { 'data-wb-loading': '' }, '读取中…') : null,
        detail ? h('div', {
          'data-wb-overlay': '',
          onClick: (e) => { if (e.target === e.currentTarget) setDetail('') },
        },
          h('button', { className: 'x', onClick: () => setDetail('') }, '✕'),
          h('div', { 'data-wb-sec': '', style: { width: 'min(920px, 96%)', maxHeight: '88%', overflow: 'auto', margin: 0 } },
            watch.loading ? h('div', { 'data-wb-loading': '' }, '读取视频…') : null,
            watch.err ? h(Err, {}, watch.err) : null,
            d ? [
              h('div', { 'data-wb-row': '' },
                h('div', { 'data-wb-cardtitle': '' }, d.title || detail),
                h('div', { 'data-wb-grow': '' }),
                h(Btn, { sm: true, onClick: () => setDetail('') }, '收起')),
              h('div', { 'data-wb-meta': '' }, [d.owner?.name, d.stat ? `播放 ${fmtNum(d.stat.view)} · 点赞 ${fmtNum(d.stat.like)}` : '', fmtDur(d.duration)].filter(Boolean).join(' · ')),
              d.ai_summary ? h('div', { 'data-wb-why': '' }, d.ai_summary) : null,
              d.transcript?.text ? h('pre', { 'data-wb-pre': '' }, String(d.transcript.text).slice(0, 2500)) : h(Note, {}, '这条没有字幕；已落库，但创作时引用不到原句。'),
            ] : null)) : null,
        h('div', { 'data-wb-grid': '' }, ...items.map((it) => h(VideoCard, {
          key: it.bvid, it,
          tier: storeMap[it.bvid]?.tier || '',
          commented: Boolean(storeMap[it.bvid]?.commented),
          onWatch: setDetail,
          onComment: openComment,
        }))),
        !loading && !items.length ? h(Note, {}, key ? '没搜到，换个词' : '热门拉不到（看看 bili 是否登录）') : null)
    }

    function SubInbox({ onCommented, cfg }) {
      const inbox = useApi('/inbox')
      const ownerTasks = useApi('/owner/tasks')
      const [composer, setComposer] = useState(null)
      const [taskOpen, setTaskOpen] = useState('')
      const [taskMsg, setTaskMsg] = useState('')
      const items = inbox.data?.items || []
      const c = inbox.data?.counts || {}
      const ownerUid = String(cfg?.ownerUid || '')
      const isOwner = (m) => Boolean(ownerUid && m.user?.mid && String(m.user.mid) === ownerUid)
      const taskStatus = (t) => ({ done: '完成', failed: '失败', stored: '已记录', chat: '已回复', 'need-bv': '等 BV' }[t.status] || t.status || '?')
      const taskDelivery = (t) => (t.delivery || []).map((x) => ({ comment: '评论', dm: '私信', stored: '仅记录' }[x] || x)).join(' + ') || '仅记录'
      const checkOwner = async () => {
        setTaskMsg('检查 @ 中…（看视频 + 总结，可能要半分钟）')
        const r = await jpost('/owner/check')
        setTaskMsg(r.ok ? '检查完了' : '检查失败：' + String(r.log || '').slice(-200))
        ownerTasks.reload()
      }
      const task = (ownerTasks.data?.tasks || []).find((t) => t.id === taskOpen)

      const replyTarget = (m) => ({
        kind: 'reply', label: m.user?.name || '',
        ctx: {
          message: m.content || '', replyingTo: m.replying_to || '', video: m.on?.title || '',
          owner: isOwner(m), ownerCall: cfg?.ownerCall || '老弟',
        },
        ids: { bv: m.on?.bvid, rpid: m.rpid, root: m.root },
      })
      const dmTarget = (m) => ({
        kind: 'dm', label: m.user?.name || '',
        ctx: { message: m.content || '', video: m.on?.title || '' },
        ids: { uid: String(m.user?.mid || '') },
      })

      return h('div', { 'data-wb-col': '' },
        h('div', { 'data-wb-row': '' },
          h(Chip, {}, `回复 ${c.replies ?? 0}`),
          h(Chip, {}, `@ ${c.mentions ?? 0}`),
          h(Chip, {}, `私信 ${c.private_messages ?? 0}`),
          h(Chip, {}, `赞 ${c.likes ?? 0}`),
          h(Chip, { ok: Boolean(cfg?.autoReply) }, `自动回复 ${cfg?.autoReply ? '开' : '关'}`),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { sm: true, onClick: inbox.reload }, '刷新')),
        h(Note, {}, '默认由 AI 写草稿；发出前一定先给你看原文，默认只检查，不发送。'),
        h('div', { 'data-wb-sec': '' },
          h('div', { 'data-wb-row': '' },
            h('b', {}, '主人请求'),
            h('span', { 'data-wb-meta': '' }, `主人在评论区 @ 它看视频 / 看评论 / 要总结 · 自动检查 ${cfg?.ownerTasksEnabled === false ? '关' : '开'}`),
            h('div', { 'data-wb-grow': '' }),
            h(Btn, { sm: true, onClick: checkOwner }, '立即检查 @')),
          h(Note, {}, '长内容默认私信交付，不塞评论区；说「别发评论区」就只私信，说「回评论区」就压成 ≤45 字。'),
          taskMsg ? h(Note, {}, taskMsg) : null,
          ...(ownerTasks.data?.tasks || []).slice(0, 6).map((t) => h('div', { key: t.id, 'data-wb-row': '' },
            h(Chip, { ok: t.status === 'done' }, taskStatus(t)),
            h('b', {}, t.title || t.bvid || '主人请求'),
            h('span', { 'data-wb-meta': '' }, `${dayOf(t.at)} · ${taskDelivery(t)}`),
            h('div', { 'data-wb-grow': '' }),
            h(Btn, { sm: true, onClick: () => setTaskOpen(t.id) }, '查看'))),
          !(ownerTasks.data?.tasks || []).length ? h(Note, {}, '还没有主人请求。在主人在视频评论里 @ 它，这里会出现。') : null),
        task ? h('div', { 'data-wb-overlay': '', onClick: (e) => { if (e.target === e.currentTarget) setTaskOpen('') } },
          h('button', { className: 'x', onClick: () => setTaskOpen('') }, '✕'),
          h('div', { 'data-wb-sec': '', style: { width: 'min(860px, 96%)', maxHeight: '88%', overflow: 'auto', margin: 0 } },
            h('div', { 'data-wb-row': '' },
              h('b', {}, task.title || task.bvid || '主人请求'),
              h('div', { 'data-wb-grow': '' }),
              h(Chip, { ok: task.status === 'done' }, taskStatus(task))),
            h('div', { 'data-wb-meta': '' }, [dayOf(task.at), task.bvid, task.mode, taskDelivery(task)].filter(Boolean).join(' · ')),
            h('div', { 'data-wb-why': '' }, '主人说：' + String(task.message || '')),
            h('pre', { 'data-wb-pre': '' }, task.summary || task.short || task.error || '（没有内容）'),
            task.error ? h(Note, {}, '错误：' + task.error) : null)) : null,
        h(Err, {}, inbox.err),
        inbox.loading ? h('div', { 'data-wb-loading': '' }, '读取中…') : null,
        composer ? h(InteractComposer, {
          key: composer.kind + (composer.ids?.rpid || composer.ids?.uid || composer.label || ''),
          kind: composer.kind, target: composer,
          onClose: () => setComposer(null),
          onSent: () => { setComposer(null); inbox.reload(); onCommented?.() },
        }) : null,
        !inbox.loading && !items.length ? h(Empty, {
          icon: '',
          title: '没有新消息',
          hint: inbox.data?.note || '有人回复、@ 你或私信你时，会出现在这里。',
        }) : null,
        ...items.map((m, i) => h('div', { key: i, 'data-wb-sec': '' },
          h('div', { 'data-wb-row': '' },
            h(Chip, {}, '回复'),
            isOwner(m) ? h(Chip, { ok: true }, '主人') : null,
            h('b', {}, m.user?.name || '?'),
            h('span', { 'data-wb-meta': '' }, [dayOf(m.time), m.on?.bvid].filter(Boolean).join(' · ')),
            h('div', { 'data-wb-grow': '' }),
            h(Btn, { sm: true, onClick: () => setComposer(replyTarget(m)) }, isOwner(m) ? '回答主人' : 'AI 写回复'),
            m.user?.mid ? h(Btn, { sm: true, onClick: () => setComposer(dmTarget(m)) }, '私信') : null),
          h('div', { 'data-wb-why': '' }, String(m.content || '')))))
    }

    function SubSettings({ onRunRound, onSaved }) {
      const cfgRes = useApi('/config')
      const canonRes = useApi('/canon/state')
      const cfg = cfgRes.data?.config
      const sched = cfgRes.data?.schedule || {}
      const [draft, setDraft] = useState(null)
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState('')

      useEffect(() => {
        if (cfg && draft === null) {
          setDraft({
            ...cfg,
            keywordsText: (cfg.keywords || []).join('\n'),
            modelChainText: (cfg.modelChain || []).join('\n'),
            tagsText: (cfg.defaultTags || []).join(','),
            mentions: (cfg.mentions || []).map((m) => ({ ...m })),
          })
        }
      }, [cfg, draft])
      if (cfgRes.loading || !draft) return h('div', { 'data-wb-loading': '' }, '读设置中…')

      const set = (k, v) => setDraft({ ...draft, [k]: v })
      const setMention = (i, k, v) => setDraft({
        ...draft,
        mentions: (draft.mentions || []).map((m, idx) => (idx === i ? { ...m, [k]: v } : m)),
      })
      const addMention = () => setDraft({ ...draft, mentions: [...(draft.mentions || []), { target: '', call: '' }] })
      const delMention = (i) => setDraft({ ...draft, mentions: (draft.mentions || []).filter((_, idx) => idx !== i) })
      const save = async () => {
        setBusy('save'); setMsg('保存中…')
        const r = await jpost('/config', {
          enabled: draft.enabled, scheduleRanges: draft.scheduleRanges, perDay: draft.perDay,
          keywords: String(draft.keywordsText || '').split('\n').map((s) => s.trim()).filter(Boolean),
          llmKey: draft.llmKey,
          personaPrompt: draft.personaPrompt, reportLevel: draft.reportLevel, favFolderId: draft.favFolderId,
          memoryEnabled: draft.memoryEnabled !== false,
          selfVideosEnabled: draft.selfVideosEnabled !== false,
          selfVideosUrl: draft.selfVideosUrl || '',
          selfVideosRefreshHours: draft.selfVideosRefreshHours,
          autoComment: draft.autoComment, autoReply: draft.autoReply,
          ownerUid: draft.ownerUid, ownerCall: draft.ownerCall,
          ownerTasksEnabled: draft.ownerTasksEnabled !== false,
          ownerTaskPollMinutes: draft.ownerTaskPollMinutes,
          ownerTaskPerDay: draft.ownerTaskPerDay,
          ownerTaskAllowDm: draft.ownerTaskAllowDm !== false,
          ownerTaskMaxAgeHours: draft.ownerTaskMaxAgeHours,
          mentionName: draft.mentionName, mentions: (draft.mentions || []).filter((m) => String(m.target || '').trim()),
          replyPerDay: draft.replyPerDay,
          dmWatch: draft.dmWatch, dmWatchMinutes: draft.dmWatchMinutes,
          voice: draft.voice, modelChain: String(draft.modelChainText || '').split('\n').map((s) => s.trim()).filter(Boolean),
        })
        setBusy('')
        if (r.ok) {
          setMsg('已保存')
          setDraft({ ...r.config, keywordsText: (r.config.keywords || []).join('\n'), modelChainText: (r.config.modelChain || []).join('\n'), tagsText: (r.config.defaultTags || []).join(',') })
          cfgRes.reload(); onSaved?.()
        } else setMsg('保存失败：' + (errText(r) || ''))
      }
      const run = async () => {
        setBusy('run'); setMsg('采集中…（采集 + 判定 + 抽句 / 弹幕 / 热梗 / 热评 + 日报，可能一两分钟）')
        const r = await jpost('/run-round')
        setBusy('')
        setMsg(r.ok ? `跑完了（${r.seconds}s）· 库里 ${r.stats?.videos ?? '?'} 条` : '跑失败：' + (errText(r) || ''))
      }
      const refreshCanon = async () => {
        setBusy('canon'); setMsg('拉取合集…')
        const r = await jpost('/canon/refresh', { url: draft.selfVideosUrl || '' })
        setBusy('')
        if (r.ok) {
          setMsg(`已更新《${r.status?.title || ''}》· ${r.status?.epCount || 0} 集`)
          canonRes.reload()
          cfgRes.reload()
        } else setMsg('拉取失败：' + (errText(r) || r.error || ''))
      }

      return h('div', { 'data-wb-col': '' },
        h('div', { 'data-wb-row': '' },
          h(Note, {}, sched.lastRunAt ? `上次：${new Date(sched.lastRunAt).toLocaleString('zh-CN')} · ${sched.lastResult || ''}` : '还没跑过'),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { primary: true, sm: true, disabled: busy === 'save', onClick: save }, busy === 'save' ? '保存中…' : '保存设置'),
          h(Btn, { sm: true, disabled: busy === 'run', onClick: run }, '开始采集'),
          msg ? h('span', { 'data-wb-note': '' }, msg) : null),
        h('div', { 'data-wb-split': '' },
          h(Sec, { title: '日常 · 定时自动刷' },
            h('label', { 'data-wb-toggle': '' },
              h('input', { type: 'checkbox', checked: Boolean(draft.enabled), onChange: (e) => set('enabled', e.target.checked) }),
              h('span', {}, '定时自动刷（总开关）')),
            h(Field, { label: '时段' },
              h('input', { 'data-wb-input': '', style: { maxWidth: '240px' }, value: draft.scheduleRanges, onChange: (e) => set('scheduleRanges', e.target.value) }),
              h(Note, {}, '全天写 00:00-24:00；可多段，如 09:00-12:00, 20:00-23:30')),
            h(Field, { label: '每天上限' },
              h('input', { 'data-wb-input': '', 'data-num': '', type: 'number', min: 1, max: 500, value: draft.perDay, onChange: (e) => set('perDay', e.target.value) }),
              h('span', {}, '条')),
            h(Field, { label: '来源' },
              h('span', {}, '综合热门 + 关注关键词（按时间自动混合）')),
            h(Note, {}, `今天已采 ${sched.todayCount ?? '?'} / 目标 ${sched.target ?? '?'} 条 · ${sched.inWindow === false ? '不在时段内' : '在时段内'}${sched.estMinutes ? ` · 约每 ${sched.estMinutes} 分钟 1 条` : ''} · 每条约 10 帧由 AI 挑`)),

          h(Sec, { title: '偏好 · 它按什么说话' },
            h('div', { 'data-wb-col': '' },
              h('div', { 'data-wb-h': '' }, '关注关键词（一行一个；和视频页标签同步，采集时与热门混合）'),
              h('textarea', { 'data-wb-input': '', 'data-area': '', rows: 4, value: draft.keywordsText, onChange: (e) => set('keywordsText', e.target.value) })),
            h('div', { 'data-wb-col': '' },
              h('div', { 'data-wb-h': '' }, '人设（判定 / 方案 / 评论都用它）'),
              h('textarea', { 'data-wb-input': '', 'data-area': '', rows: 6, value: draft.personaPrompt || '', onChange: (e) => set('personaPrompt', e.target.value), placeholder: '例：叫我老弟，说话像贴吧老哥，犀利不客气，控制在 40 字内' })),
            h('div', { 'data-wb-col': '' },
              h('label', { 'data-wb-toggle': '' },
                h('input', { type: 'checkbox', checked: draft.memoryEnabled !== false, onChange: (e) => set('memoryEnabled', e.target.checked) }),
                h('span', {}, '让咕嘎有记忆（评论 / 回复 / 出方案时自动带上你的偏好和它的经历）')),
              h(Note, {}, '人设是「它是谁」，不随开关变；这里管的是它记不记得住事。记了什么、删掉哪条，去「我的 → 记忆」看；任务后复盘提炼习惯也跟着这个开关走。')),
            h('div', { 'data-wb-col': '' },
              h('div', { 'data-wb-h': '' }, '自己的视频（B站合集）'),
              h('label', { 'data-wb-toggle': '' },
                h('input', { type: 'checkbox', checked: draft.selfVideosEnabled !== false, onChange: (e) => set('selfVideosEnabled', e.target.checked) }),
                h('span', {}, '把合集里的日常短片当身份背景，评论 / 回复 / 方案可以自然引用')),
              h('div', { 'data-wb-row': '' },
                h('input', {
                  'data-wb-input': '', style: { maxWidth: '460px' }, value: draft.selfVideosUrl || '',
                  onChange: (e) => set('selfVideosUrl', e.target.value),
                  placeholder: 'https://space.bilibili.com/<UID>/lists/<合集ID>',
                }),
                h(Btn, { sm: true, disabled: busy === 'canon', onClick: refreshCanon }, busy === 'canon' ? '拉取中…' : '更新合集')),
              h(Note, {}, canonRes.data?.ok
                ? `已缓存《${canonRes.data.title}》${canonRes.data.epCount} 集 · ${canonRes.data.fetchedAt ? new Date(canonRes.data.fetchedAt).toLocaleString('zh-CN') : ''}`
                : '还没缓存：填合集链接后点「更新合集」'),
              h(Note, {}, '只取最近和相关几条放进提示词，不写进记忆；之后每 6 小时自动检查是否过期。')),
            h(Field, { label: '日报粒度' },
              h(Select, { 'data-wb-input': '', style: { width: '120px' }, 'aria-label': '日报粒度', value: draft.reportLevel, onChange: (e) => set('reportLevel', e.target.value) },
                h('option', { value: 'full' }, '完整'),
                h('option', { value: 'brief' }, '薄版'),
                h('option', { value: 'off' }, '不写'))),
            h(Field, { label: '自动收藏到' },
              h('input', { 'data-wb-input': '', style: { maxWidth: '180px' }, value: draft.favFolderId || '', onChange: (e) => set('favFolderId', e.target.value), placeholder: '收藏夹 ID / 名称（留空不收藏）' }))),

          h(Sec, { title: '互动 · 自动评论与回复' },
            h(Field, { label: '主人 UID' },
              h('input', { 'data-wb-input': '', style: { maxWidth: '180px' }, value: draft.ownerUid || '', onChange: (e) => set('ownerUid', e.target.value), placeholder: '例如 123456789（你的 UID）' }),
              h(Note, {}, '只有这个 UID 的指令会被当主人；其他人问统计/配置会收到一句礼貌拒绝，不会拿到数据')),
            h(Field, { label: '称呼' },
              h('input', { 'data-wb-input': '', style: { maxWidth: '120px' }, value: draft.ownerCall || '', onChange: (e) => set('ownerCall', e.target.value), placeholder: '老弟' }),
              h(Note, {}, '评论里会自然称呼这个称呼')),
            h('div', { 'data-wb-col': '' },
              h('div', { 'data-wb-h': '' }, '主人 @ 任务（看视频 / 看评论 / 要总结）'),
              h('label', { 'data-wb-toggle': '' },
                h('input', { type: 'checkbox', checked: draft.ownerTasksEnabled !== false, onChange: (e) => set('ownerTasksEnabled', e.target.checked) }),
                h('span', {}, '主人在评论区 @ 它就执行')),
              h('div', { 'data-wb-row': '' },
                h('span', {}, '每'),
                h('input', { 'data-wb-input': '', 'data-num': '', type: 'number', min: 1, max: 60, style: { width: '70px' }, value: draft.ownerTaskPollMinutes ?? 3, onChange: (e) => set('ownerTaskPollMinutes', e.target.value) }),
                h('span', {}, '分钟检查一次；每天最多'),
                h('input', { 'data-wb-input': '', 'data-num': '', type: 'number', min: 1, max: 50, style: { width: '70px' }, value: draft.ownerTaskPerDay ?? 10, onChange: (e) => set('ownerTaskPerDay', e.target.value) }),
                h('span', {}, '个')),
              h('label', { 'data-wb-toggle': '' },
                h('input', { type: 'checkbox', checked: draft.ownerTaskAllowDm !== false, onChange: (e) => set('ownerTaskAllowDm', e.target.checked) }),
                h('span', {}, '长总结用私信发我（不塞评论区）')),
              h(Note, {}, '任务默认只私信 / 工作台，不往评论区塞；说「回评论区」才回 ≤45 字短版。私信需要先在「我的」里扫码登录 bili-cli；没登录时长内容只留在工作台。')),
            h('label', { 'data-wb-toggle': '' },
              h('input', { type: 'checkbox', checked: Boolean(draft.autoComment), onChange: (e) => set('autoComment', e.target.checked) }),
              h('span', {}, '自动评论并 @ 主人（每条采到的视频都留一条）')),
            h('div', { 'data-wb-col': '' },
              h('div', { 'data-wb-h': '' }, '额外 @（可多人）'),
              h(Note, {}, `自动评论会 @ 这些人，并按「称呼」自然喊出来。B站一条评论最多 @ 3 人（含主人 UID），所以这里最多再加 ${draft.ownerUid ? 2 : 3} 个；主人 UID 会自动 @，不用重复加。`),
              ...(draft.mentions || []).map((m, i) => h('div', { key: i, 'data-wb-row': '' },
                h('input', {
                  'data-wb-input': '', style: { maxWidth: '200px' }, value: m.target || '',
                  onChange: (e) => setMention(i, 'target', e.target.value), placeholder: 'UID 或昵称',
                }),
                h('input', {
                  'data-wb-input': '', style: { maxWidth: '130px' }, value: m.call || '',
                  onChange: (e) => setMention(i, 'call', e.target.value), placeholder: '称呼，如 爸爸',
                }),
                h(Btn, { sm: true, onClick: () => delMention(i) }, '移除'))),
              (draft.mentions || []).length < (draft.ownerUid ? 2 : 3)
                ? h('div', { 'data-wb-row': '' }, h(Btn, { sm: true, onClick: addMention }, '+ 加一个人'))
                : h(Note, {}, '已达到 3 个 @ 上限')),
            h('div', { 'data-wb-row': '', style: { marginTop: '4px' } },
              h('label', { 'data-wb-toggle': '' },
                h('input', { type: 'checkbox', checked: Boolean(draft.autoReply), onChange: (e) => set('autoReply', e.target.checked) }),
                h('span', {}, '有人回复就自动回（主人指令会优先回答）'))),
            h(Field, { label: '每天最多回复' },
              h('input', { 'data-wb-input': '', 'data-num': '', type: 'number', min: 0, max: 200, value: draft.replyPerDay, onChange: (e) => set('replyPerDay', e.target.value) }),
              h('span', {}, '条（0=不限）')),
            h('div', { 'data-wb-row': '' },
              h('label', { 'data-wb-toggle': '' },
                h('input', { type: 'checkbox', checked: Boolean(draft.dmWatch), onChange: (e) => set('dmWatch', e.target.checked) }),
                h('span', {}, '私信监听（默认关，每')),
              h('input', { 'data-wb-input': '', 'data-num': '', type: 'number', min: 3, max: 240, value: draft.dmWatchMinutes, onChange: (e) => set('dmWatchMinutes', e.target.value) }),
              h('span', {}, '分钟看一眼）'))),

          h(Sec, { title: '模型链（判定 / 方案 / 互动都用它）' },
            h('textarea', {
              'data-wb-input': '', 'data-area': '', rows: Math.max(4, (draft.modelChainText || '').split('\n').length),
              value: draft.modelChainText, onChange: (e) => set('modelChainText', e.target.value),
            }),
            h(Note, {}, '一行一个；失败自动换下一个，429 退避重试。'),
            h(Field, { label: '默认音色' },
              h(Select, { 'data-wb-input': '', style: { width: '190px' }, 'aria-label': '默认音色', value: draft.voice, onChange: (e) => set('voice', e.target.value) },
                h('option', { value: 'zh-CN-YunxiNeural' }, '云希（男·青年）'),
                h('option', { value: 'zh-CN-XiaoxiaoNeural' }, '晓晓（女·通用）'),
                h('option', { value: 'zh-CN-XiaoyiNeural' }, '晓伊（女·年轻）'),
                h('option', { value: 'zh-CN-YunxiaNeural' }, '云夏（少年）')))),
        ),
        h(Err, {}, cfgRes.err))
    }

    function TabScroll() {
      const [sub, setSub] = useState('video')
      const [running, setRunning] = useState(false)
      const [runMsg, setRunMsg] = useState('')
      const cfgRes = useApi('/config')
      const store = useApi('/store/list?limit=500')
      const storeMap = useMemo(() => {
        const m = {}
        for (const r of (store.data?.rows || [])) {
          m[r.bvid] = {
            tier: r.judge?.tier || '',
            commented: Boolean(r.commented),
            title: r.title || '',
            up: r.up?.name || '',
            quotes: (r.quotes || []).slice(0, 3).map((x) => x.text),
          }
        }
        return m
      }, [store.data])
      const today = store.data?.stats?.videos ?? 0
      const runRound = async () => {
        setRunning(true)
        setRunMsg('采集中…（采集 + 判定 + 日报，一般 1–2 分钟）')
        const r = await jpost('/run-round')
        setRunning(false)
        setRunMsg(r.ok ? `跑完了（${r.seconds}s）· 库里 ${r.stats?.videos ?? '?'} 条` : ('跑失败：' + (errText(r) || '')))
        cfgRes.reload(); store.reload()
      }
      return h('div', { 'data-wb-page': '' },
        h(PageHead, { title: sub === 'msg' ? '刷B站 · 消息' : sub === 'set' ? '刷B站 · 设置' : '刷B站', sub: sub === 'msg' ? '未读、回复、@、私信 —— 回复先给草稿' : sub === 'set' ? '管理采集频率、内容偏好与互动权限' : '看视频、挑视频、采集成素材' },
          h('span', { 'data-wb-chip': '' }, `今日已采 ${cfgRes.data?.schedule?.todayCount ?? '?'} 条`),
          h(Btn, { sm: true, primary: true, disabled: running, onClick: runRound }, running ? '采集中…' : '开始采集'),
          sub === 'video' ? h(Btn, { sm: true, onClick: () => { cfgRes.reload(); store.reload() } }, '刷新') : null),
        runMsg ? h(Note, {}, runMsg) : null,
        h('div', { 'data-wb-row': '' },
          ...[['video', '视频'], ['msg', '消息']].map(([k, l]) =>
            h('button', { key: k, 'data-wb-btn': '', 'data-sm': '', 'data-primary': sub === k ? '' : undefined, onClick: () => setSub(k) }, l))),
        sub === 'video' ? h(SubVideo, { storeMap, cfg: cfgRes.data?.config, onCommented: store.reload, onKeywordsChanged: cfgRes.reload }) : null,
        sub === 'msg' ? h(SubInbox, { onCommented: store.reload, cfg: cfgRes.data?.config }) : null)
    }

    function TabScrollSettings() {
      return h('div', { 'data-wb-page': '' },
        h(PageHead, { title: '刷B站设置', sub: '采集计划、内容偏好、互动权限与模型配置' }),
        h(SubSettings))
    }

    /* ═══════════════════ ③ 创作中心 ═══════════════════ */
    function ProjectCard({ p, onChange, onDeleted }) {
      const [style, setStyle] = useState(p.plan?.style || 'A')
      const [customStyle, setCustomStyle] = useState(p.plan?.customStyle || '')
      useEffect(() => { setStyle(p.plan?.style || 'A'); setCustomStyle(p.plan?.customStyle || '') }, [p.id, p.currentVersion])
      const [inst, setInst] = useState('')
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [showShots, setShowShots] = useState(false)
      const [editing, setEditing] = useState(false)
      const [deleteConfirm, setDeleteConfirm] = useState(false)
      const [viewV, setViewV] = useState(0)
      const [viewPlan, setViewPlan] = useState(null)
      const [preview, setPreview] = useState('')
      useEffect(() => {
        if (!preview) return
        const close = e => { if (e.key === 'Escape') setPreview('') }
        window.addEventListener('keydown', close)
        return () => window.removeEventListener('keydown', close)
      }, [preview])
      const [logOpen, setLogOpen] = useState(false)
      const plan = viewV ? (viewPlan || p.plan) : p.plan
      const job = p.job
      const stage = job?.stage === 'running' ? 'rendering' : job?.stage === 'failed' ? 'failed' : p.stage
      const [label, tone] = stageOf(stage)
      const pct = job?.stage === 'running' ? (job.pct || 0) : (['rendered', 'approved', 'submitted', 'published', 'platform_rejected', 'uploading', 'upload_unknown'].includes(p.stage) ? 100 : 0)
      const runId = baseName(p.runDir)
      const shots = plan?.shots || []
      const picks = plan?.picks || []
      const currentPlan = p.plan
      const versions = p.versions || []
      const curV = p.currentVersion || 1

      const showVersion = async (v) => {
        if (!v || v === curV) { setViewV(0); setViewPlan(null); return }
        setViewV(v); setViewPlan(null); setBusy('v')
        const r = await jget(`/create/plan?id=${encodeURIComponent(p.id)}&v=${v}`)
        if (r.ok) setViewPlan(r.plan)
        else { setViewV(0); setMsg('读取版本失败：' + errText(r)) }
        setBusy('')
      }
      const revise = async () => {
        if (!inst.trim() && style === p.plan?.style && (style !== 'C' || customStyle === (p.plan?.customStyle || ''))) return
        setBusy('revise'); setMsg('改版中…（模型重写方案，20–60 秒）')
        const r = await jpost('/create/revise', { id: p.id, instruction: inst.trim() || '按选择的创作风格重新编排这期视频，保留主题及真实素材', style, customStyle })
        setBusy('')
        setMsg(r.ok ? `已生成 v${r.project.currentVersion}：${r.plan.changed || ''}` : ('失败：' + (errText(r) || '')))
        if (r.ok) { setInst(''); setViewV(0); setViewPlan(null); onChange?.() }
      }
      const render = async () => {
        setBusy('render'); setMsg('开始渲染…')
        const r = await jpost('/render/start', { id: p.id, version: viewV || curV })
        setBusy('')
        setMsg(r.ok ? '已在后台渲染（配音 → 渲染 → 合音轨 → 烧字幕 → 封面）' : ('失败：' + (errText(r) || '')))
        if (r.ok) { setLogOpen(true); onChange?.() }
      }
      const promptGo = async () => {
        setBusy('prompt')
        const r = await jget(`/create/prompt?id=${encodeURIComponent(p.id)}&v=${viewV || curV}`)
        setBusy('')
        if (!r.ok) return setMsg('取提示词失败：' + (errText(r) || ''))
        const ok = await copyText(r.prompt)
        setMsg(ok ? '提示词已复制 —— 粘到 dsh 对话里继续聊' : '复制失败，可以展开手动复制')
      }
      const togglePreview = () => {
        if (!runId) return
        setPreview(preview ? '' : `/api/bili-wb/review/media?runId=${encodeURIComponent(runId)}&kind=video`)
      }
      const remove = async () => {
        if (busy === 'del') return
        setBusy('del'); setMsg('删除中…')
        const r = await jpost('/create/delete', { id: p.id })
        setBusy('')
        if (r.ok) { setDeleteConfirm(false); onDeleted?.(p.id); onChange?.() }
        else setMsg('删除失败：' + (errText(r) || '服务端未完成删除，请刷新后重试'))
      }

      return h('article', { 'data-wb-sec': '', 'data-wb-project': p.id, 'data-wb-project-card': '' },
        h('div', { 'data-wb-project-head': '' },
          h('div', { 'data-wb-projtitle': '' }, plan?.title || p.title || '未命名'),
          h('span', { 'data-wb-badge': '', 'data-tone': tone }, label),
          h(Select, { 'data-wb-version': '', 'aria-label': '方案版本', value: viewV || curV, disabled: Boolean(busy), onChange: e => showVersion(Number(e.target.value)) },
            ...(versions.length ? [...versions].reverse() : [{ v: curV }]).map(x => h('option', { key: x.v, value: x.v }, 'v' + x.v + (x.v === curV ? ' · 当前版本' : ' · 历史版本'))))),
        h('div', { 'data-wb-meta': '' },
          [plan?.style ? styleNames[plan.style] : '原方案', plan?.stats?.estSeconds ? `${plan.stats.estSeconds} 秒` : '', p.renderVoice ? `音色 ${voiceLabel(p.renderVoice)}` : '', `${shots.length} 镜`, `引用素材 ${picks.length} 处`].filter(Boolean).join(' · ')),
        job?.stage === 'running' ? h('div', { 'data-wb-bar': '', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': '渲染进度' }, h('i', { style: { width: pct + '%' } })) : null,
        job?.stage === 'running' ? h(Note, {}, '渲染中 ' + (job.pct || 0) + '%') : null,
        plan?.angle ? h('div', { 'data-wb-plan-angle': '' }, plan.angle) : null,
        editing ? h('div', { 'data-wb-edit-panel': '' },
          h('div', { 'data-wb-h': '' }, '修改方案'),
          h('div', { 'data-wb-col': '' },
            h(CreativePicker, { style, customStyle, onStyle: setStyle, onCustom: setCustomStyle, disabled: Boolean(busy) || job?.stage === 'running' }),
            h('textarea', { 'data-wb-input': '', 'data-area': '', placeholder: '告诉我哪里要改，例如：保留原声，把最后一个反转放到结尾', value: inst, onChange: e => setInst(e.target.value) }),
            h('div', { 'data-wb-row': '' },
              h(Btn, { primary: true, disabled: Boolean(busy) || job?.stage === 'running' || (!inst.trim() && style === p.plan?.style && (style !== 'C' || customStyle === (p.plan?.customStyle || ''))), onClick: revise }, busy === 'revise' ? '生成中…' : '生成新版本'),
              h(Note, {}, '修改保存为新版本，确认方案后再渲染。')),
            h('div', { 'data-wb-row': '' },
              h(Btn, { sm: true, disabled: Boolean(busy), onClick: promptGo }, '复制创作提示词'),
              viewV ? h(Btn, { sm: true, disabled: Boolean(busy), onClick: () => showVersion(curV) }, '返回当前版本') : null,
              h('div', { 'data-wb-grow': '' }),
              h(Btn, { sm: true, onClick: () => setEditing(false) }, '收起修改')))) : null,
        h('div', { 'data-wb-project-actions': '' },
          h(Btn, { sm: true, primary: !p.hasVideo, disabled: Boolean(busy) || job?.stage === 'running', onClick: render }, job?.stage === 'running' ? '渲染中…' : (p.hasVideo ? '重新渲染' : '开始渲染')),
          p.hasVideo ? h(Btn, { sm: true, primary: true, disabled: !runId, onClick: togglePreview }, '预览成片') : null,
          h(Btn, { sm: true, 'aria-expanded': editing, onClick: () => setEditing(!editing) }, editing ? '收起修改' : '修改方案'),
          h(Btn, { sm: true, 'aria-expanded': showShots, onClick: () => setShowShots(!showShots) }, showShots ? '收起分镜' : '查看分镜'),
          h('div', { 'data-wb-grow': '' }),
          job?.log ? h(Btn, { sm: true, onClick: () => setLogOpen(!logOpen) }, logOpen ? '收起日志' : '渲染日志') : null,
          h(Btn, { sm: true, disabled: Boolean(busy) || job?.stage === 'running', onClick: () => { setDeleteConfirm(true); setMsg('') }, 'data-wb-danger-link': '' }, '删除方案')),
        deleteConfirm ? h('div', { 'data-wb-delete-confirm': '', role: 'alert', 'aria-label': '删除方案确认' },
          h('div', {}, h('b', {}, '确认删除这个方案？'), h('div', { 'data-wb-note': '' }, '包含所有历史版本；已渲染的成片会保留。')),
          h('div', { 'data-wb-row': '' },
            h(Btn, { sm: true, disabled: Boolean(busy), onClick: () => setDeleteConfirm(false) }, '取消'),
            h(Btn, { sm: true, disabled: Boolean(busy), 'data-wb-danger': '', onClick: remove }, busy === 'del' ? '删除中…' : '确认删除方案'))) : null,
        showShots ? h('div', { 'data-wb-col': '' }, ...shots.map((s, i) => h('div', { key: i, 'data-wb-quote': '' },
          h('b', {}, `${i + 1}. ${shotNames[s.kind] || s.kind}`), ' ', s.headline || '', s.body ? ` — ${s.body}` : '',
          h('div', { 'data-wb-meta': '', style: { marginTop: '3px' } },
            [s.audioMode === 'original' ? '原声 ' + s.duration + ' 秒' : s.narration, s.overlay ? '吐槽字幕：' + s.overlay : '', s.source ? `引用 ${s.source.bv} @${mmss(s.source.t)}` : ''].filter(Boolean).join(' · '))))) : null,
        msg ? (/失败|错误/.test(msg) ? h(Err, {}, msg) : h(Note, {}, msg)) : null,
        job?.stage === 'failed' ? h(Err, {}, job.error || '渲染失败，请重新尝试') : null,
        logOpen && job?.log ? h('pre', { 'data-wb-pre': '' }, job.log.slice(-2600)) : null,
        preview ? h('div', { 'data-wb-overlay': '', role: 'dialog', 'aria-modal': true, 'aria-label': '成片预览', onClick: e => { if (e.target === e.currentTarget) setPreview('') } },
          h('button', { className: 'x', 'aria-label': '关闭预览（Esc）', onClick: () => setPreview('') }, '✕'),
          h('video', { src: preview, controls: true, autoPlay: true })) : null)
    }

    /* ── 长任务卡：素材不够就自己去 B站 找，够了再写方案 ── */
    const TASK_STATUS = {
      queued: ['排队中', ''],
      checking: ['检查素材库', ''],
      collecting: ['逛 B站 中', 'warn'],
      short: ['素材不足，继续找', 'warn'],
      planning: ['写方案中', ''],
      ready: ['方案已生成', 'ok'],
      failed: ['已停止', 'warn'],
      paused: ['已暂停', ''],
    }
    function TaskCard({ t, onChange }) {
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [label, tone] = TASK_STATUS[t.status] || ['处理中', '']
      const last = (t.log || []).slice(-1)[0]
      const left = t.deadline ? Math.max(0, Math.ceil((Date.parse(t.deadline) - Date.now()) / 86400_000)) : 0
      const live = ['queued', 'checking', 'collecting', 'planning'].includes(t.status)
      const act = async (action) => {
        setBusy(action); setMsg('')
        const r = await jpost('/task/' + action, { id: t.id })
        setBusy('')
        if (!r.ok) setMsg(errText(r) || '操作失败')
        onChange?.()
      }
      const viewPlan = () => {
        const el = document.querySelector(`[data-wb-project="${t.projectId}"]`)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        else setMsg('方案就在下面，往下翻一下')
      }
      const time = (iso) => {
        try { return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) } catch { return '' }
      }
      return h('div', { 'data-wb-sec': '' },
        h('div', { 'data-wb-row': '' },
          h(Chip, {}, '任务'),
          h(Chip, { ok: tone === 'ok', warn: tone === 'warn' }, label),
          h('b', {}, t.topic || t.brief || '未命名任务'),
          h('div', { 'data-wb-grow': '' }),
          t.status === 'ready' && t.projectId ? h(Btn, { sm: true, primary: true, onClick: viewPlan }, '查看方案') : null,
          live ? h(Btn, { sm: true, disabled: busy === 'pause', onClick: () => act('pause') }, '暂停') : null,
          t.status === 'paused' ? h(Btn, { sm: true, disabled: busy === 'resume', onClick: () => act('resume') }, '继续') : null,
          (t.status === 'short' || t.status === 'failed' || t.status === 'queued') ? h(Btn, {
            sm: true, primary: t.status !== 'queued', disabled: Boolean(busy), onClick: () => act('retry'),
          }, busy === 'retry' ? '启动中…' : '现在再找一轮') : null,
          h(Btn, { sm: true, disabled: Boolean(busy), onClick: () => act('delete') }, '删除')),
        h('div', { 'data-wb-meta': '' }, String(t.brief || '')),
        h('div', { 'data-wb-meta': '' },
          [
            t.style ? styleNames[t.style] : '',
            `素材 ${t.matched ?? 0}/${t.needed ?? 3}`,
            t.attempts ? `第 ${t.attempts} 轮` : '',
            t.deadline ? `剩 ${left} 天` : '',
            t.planTitle ? `方案：${t.planTitle}` : '',
            t.lastError ? t.lastError : '',
          ].filter(Boolean).join(' · ')),
        h('div', { 'data-wb-meta': '' },
          last ? `最近：${String(last.text || '')}${last.at ? `（${time(last.at)}）` : ''}` : '还没开始'),
        t.status === 'collecting' ? h(Note, {}, '正在 B站 搜索并采集，几分钟后回来看；找不到就过几小时再找。') : null,
        t.status === 'planning' ? h(Note, {}, '素材够了，正在写分镜方案，一般 20–60 秒。') : null,
        msg ? h(Note, {}, msg) : null)
    }

    function TabCreate() {
      const [style, setStyle] = useState('A')
      const [customStyle, setCustomStyle] = useState('')
      const [brief, setBrief] = useState('')
      const [busy, setBusy] = useState('')
      const [log, setLog] = useState('')
      const list = useApi('/create/plans')
      const taskList = useApi('/task/list')
      const [deletedIds, setDeletedIds] = useState([])
      const projects = (list.data?.projects || []).filter(p => !deletedIds.includes(p.id))
      const taskRows = taskList.data?.tasks || []
      const activeTasks = taskRows.filter((t) => ['queued', 'checking', 'collecting', 'planning'].includes(t.status)).length
      const anyRunning = projects.some((p) => p.job?.stage === 'running')
      usePoll(list.reload, 4000, true)
      usePoll(taskList.reload, 4000, true)

      const go = async () => {
        if (!brief.trim()) return
        setBusy('go'); setLog('已创建任务：先查素材库，不够就自己去 B站 找（进度看下面）')
        const r = await jpost('/task/create', { brief, style, customStyle })
        setBusy('')
        if (r.ok) {
          setLog(`任务已创建${r.task?.topic ? `：${r.task.topic}` : ''}。素材不够会按关键词去「刷B站」找，够了自动写方案。`)
          setBrief(''); taskList.reload(); list.reload()
        } else setLog('失败：' + (errText(r) || ''))
      }
      return h('div', { 'data-wb-page': '' },
        h(PageHead, { title: '创作中心', sub: '写下想法，选择风格。生成方案后可修改、渲染，再到成片投稿。' }),
        h('section', { 'data-wb-sec': '', 'data-wb-new-project': '' },
          h('div', { 'data-wb-h': '' }, '新建视频'),
          h('textarea', {
            'data-wb-input': '', 'data-area': '', rows: 2, 'aria-label': '视频创作需求', placeholder: '比如：做一期土味名场面，前面一本正经，最后反转，60 秒以内',
            value: brief, onChange: (e) => setBrief(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) go() },
          }),
          h('div', { 'data-wb-compose-foot': '' },
            h(CreativePicker, { style, customStyle, onStyle: setStyle, onCustom: setCustomStyle, disabled: Boolean(busy) }),
            h(Btn, { primary: true, disabled: busy === 'go' || !brief.trim(), onClick: go }, busy === 'go' ? '创建任务中…' : '生成方案'),
            h('span', { 'data-wb-note': '', 'data-wb-compose-hint': '' }, '素材不足时自动采集 · Ctrl+Enter')),
          log ? h('pre', { 'data-wb-pre': '' }, log) : null),
        taskRows.length ? h('details', { 'data-wb-sec': '', 'data-wb-task-history': '' },
          h('summary', {}, `采集与编排任务 · ${activeTasks ? activeTasks + ' 个进行中' : taskRows.length + ' 条记录'}`),
          h(Note, {}, '素材不够时按关键词自己去「刷B站」找；够料后自动写方案。不会自动渲染、不会自动投稿。'),
          h('div', { 'data-wb-col': '' }, ...taskRows.map((t) => h(TaskCard, {
            key: t.id, t, onChange: () => { taskList.reload(); list.reload() },
          })))) : null,
        h('div', { 'data-wb-row': '' },
          h(Note, {}, `共 ${projects.length} 个方案${anyRunning ? ' · 有项目在渲染' : ''}`),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { sm: true, onClick: list.reload }, '刷新')),

        h(Err, {}, list.err),
        list.loading ? h('div', { 'data-wb-loading': '' }, '读方案…') : null,
        !list.loading && !projects.length ? h(Empty, {
          icon: 'create',
          title: '还没有方案',
          hint: '在上面写一句需求，点「生成方案」。素材不够时它会自己去「刷B站」找。',
        }) : null,
        h('div', { 'data-wb-col': '' }, ...projects.map((p) => h(ProjectCard, {
          key: p.id, p, onChange: list.reload, onDeleted: id => { setDeletedIds(ids => [...ids, id]); taskList.reload() },
        }))),
        h(Note, {}, '音色、时长等出片设置可在「刷B站设置」调整。'))
    }

    /* ═══════════════════ ④ 成片投稿 ═══════════════════ */
    function TabReview() {
      const list = useApi('/review/list')
      const [busy, setBusy] = useState('')
      const [dump, setDump] = useState('')
      const [preview, setPreview] = useState('')
      useEffect(() => {
        if (!preview) return
        const close = e => { if (e.key === 'Escape') setPreview('') }
        window.addEventListener('keydown', close)
        return () => window.removeEventListener('keydown', close)
      }, [preview])
      const [delArm, setDelArm] = useState('')
      const delTimer = useRef(null)
      useEffect(() => () => clearTimeout(delTimer.current), [])
      const [filter, setFilter] = useState('all')
      const runs = list.data?.runs || []
      const groups = {
        all: () => true,
        pending: r => ['rendered', 'rejected'].includes(r.stage),
        approved: r => r.stage === 'approved',
        submitted: r => ['submitted', 'published', 'platform_rejected', 'uploading', 'upload_unknown'].includes(r.stage),
      }
      const visibleRuns = runs.filter(groups[filter] || groups.all)
      const publishEnabled = Boolean(list.data?.publishEnabled)
      usePoll(list.reload, 5000, true)

      const decide = async (runId, state) => {
        setBusy(runId + state)
        const r = await jpost('/review/decision', { runId, state })
        setBusy('')
        setDump(r.ok ? `已${state === 'approved' ? '通过' : '打回'}：${runId}` : ('失败：' + (errText(r) || '')))
        list.reload()
      }
      const upload = async (run, dryRun) => {
        if (!dryRun && !window.confirm('确认提交到 B站？提交后将进入平台审核，审核通过后按稿件设置展示。')) return
        setBusy(run.runId + (dryRun ? 'dry' : 'real'))
        const r = await jpost('/review/upload', { runId: run.runId, dryRun, confirm: !dryRun })
        setBusy('')
        setDump(r.ok
          ? `${r.dryRun ? '投稿检查（没有真的发）' : '投稿已提交，等待平台处理'}${r.data?.bvid ? ` · BV ${r.data.bvid}` : ''}\n$ ${(r.command || []).join(' ')}\n${JSON.stringify(r.data || {}, null, 2).slice(0, 2000)}`
          : ('失败：' + (errText(r) || '')))
        list.reload()
      }
      const syncPublication = async (run) => {
        let bvid = run.bvid || run.upload?.bvid || ''
        if (!bvid) {
          bvid = window.prompt('请先在B站创作中心确认是否已有稿件；已有则填写对应BV号，用于核对状态。') || ''
          if (!bvid.trim()) return
        }
        setBusy(run.runId + 'sync')
        const result = await jpost('/review/sync', { runId: run.runId, bvid: bvid.trim() })
        setBusy('')
        setDump(result.ok ? '平台状态：' + (result.data?.state_desc || stageOf(result.stage)[0]) : '同步失败：' + errText(result))
        list.reload()
      }
      const allowRetry = async (run) => {
        if (!window.confirm('请先在B站创作中心核对。只有确认没有产生稿件时才允许重试，否则可能重复投稿。确认没有稿件？')) return
        setBusy(run.runId + 'retry')
        const result = await jpost('/review/retry', { runId: run.runId, confirmNotSubmitted: true })
        setBusy('')
        setDump(result.ok ? '已解除未知状态，可以重新检查并投稿。' : errText(result))
        list.reload()
      }
      const showStats = async (run) => {
        setBusy(run.runId + 'stats')
        const r = await jget('/review/stats?runId=' + encodeURIComponent(run.runId))
        setBusy('')
        setDump(r.ok ? JSON.stringify(r.data || {}, null, 2).slice(0, 3000) : ('失败：' + (errText(r) || '')))
      }
      const remove = async (run) => {
        if (busy === run.runId + 'del') return
        if (delArm !== run.runId) {
          setDelArm(run.runId)
          clearTimeout(delTimer.current)
          delTimer.current = setTimeout(() => setDelArm(''), 4000)
          return
        }
        clearTimeout(delTimer.current)
        setDelArm('')
        setBusy(run.runId + 'del')
        const r = await jpost('/review/delete', { runId: run.runId })
        setBusy('')
        setDump(r.ok ? '' : ('删除失败：' + (errText(r) || '')))
        list.reload()
      }
      return h('div', { 'data-wb-page': '' },
        h(PageHead, { title: '成片投稿', sub: '本地通过后可投稿；提交后通过同步状态确认平台审核与发布结果' },
          h('span', { 'data-wb-chip': '', 'data-ok': publishEnabled ? '' : undefined }, publishEnabled ? '投稿权限已开启' : '投稿权限未开启'),
          h(Btn, { sm: true, onClick: list.reload }, '刷新')),
        h(Err, {}, list.err),
        h(Note, {}, '「删除成片」只清本地文件，不会删除 B站 上已发布的内容；删除后项目回到草稿，可以重新渲染。'),
        dump ? h('pre', { 'data-wb-pre': '' }, dump) : null,
        list.loading ? h('div', { 'data-wb-loading': '' }, '读成片…') : null,
        !list.loading && !runs.length ? h(Empty, {
          icon: 'scroll',
          title: '还没有成片',
          hint: '去「创作中心」写一句需求，渲染完成后会自动出现在这里。',
        }) : null,
        h('div', { 'data-wb-row': '', 'aria-label': '成片状态筛选' },
          ...[['all', '全部'], ['pending', '待本地审核'], ['approved', '待投稿'], ['submitted', '投稿记录']].map(([key, name]) =>
            h(Btn, { key, sm: true, primary: filter === key, 'aria-pressed': filter === key, onClick: () => setFilter(key) }, name + ' ' + runs.filter(groups[key]).length))),
        !list.loading && runs.length > 0 && !visibleRuns.length ? h(Empty, { title: '此状态暂无成片', hint: '可以切换其他状态查看。' }) : null,
        h('div', { 'data-wb-grid': '' }, ...visibleRuns.map((r) => {
          const [label, tone] = stageOf(r.stage)
          const published = Boolean(r.bvid || r.upload?.bvid || ['submitted', 'published', 'platform_rejected', 'uploading', 'upload_unknown'].includes(r.stage) || r.review?.state === 'published')
          return h('div', { key: r.runId, 'data-wb-card': '' },
            h('div', { 'data-wb-cover': '' },
              h('span', {}, published ? (r.stage === 'published' ? '平台已发布成片' : stageOf(r.stage)[0]) : r.stage === 'rendered' ? '待审成片' : r.title || r.runId),
              r.hasCover ? h('img', { src: `/api/bili-wb/review/media?runId=${encodeURIComponent(r.runId)}&kind=cover`, alt: '', loading: 'lazy', onError: (e) => { e.target.style.display = 'none' } }) : null,
              h('span', { 'data-wb-badge': '', 'data-tone': tone, style: { position: 'absolute', left: '8px', top: '8px', zIndex: 2 } }, label),
              h('span', { 'data-wb-dur': '' }, r.seconds ? `${Math.round(r.seconds)}s` : '')),
            h('div', { 'data-wb-body': '' },
              h('div', { 'data-wb-cardtitle': '' }, r.title || r.runId),
              h('div', { 'data-wb-meta': '' }, [r.projectVersion ? `v${r.projectVersion}` : '', r.shots ? `${r.shots} 镜` : '', r.realFrames ? `真实帧 ${r.realFrames}` : '', r.builtAt ? dayOf(r.builtAt) : ''].filter(Boolean).join(' · ')),
              h('div', { 'data-wb-row': '' },
                published
                  ? h(Btn, { sm: true, primary: true, disabled: Boolean(busy) || !(r.bvid || r.upload?.bvid), onClick: () => showStats(r) }, '看数据')
                  : h(Btn, { sm: true, primary: true, disabled: Boolean(busy) || !r.hasVideo || r.stage === 'approved', onClick: () => decide(r.runId, 'approved') }, '本地审核通过'),
                published ? null : h(Btn, { sm: true, disabled: Boolean(busy) || !r.hasVideo, onClick: () => decide(r.runId, 'rejected') }, '打回重做'),
                h('div', { 'data-wb-grow': '' }),
                h(Btn, { sm: true, disabled: !r.hasVideo, onClick: () => setPreview(`/api/bili-wb/review/media?runId=${encodeURIComponent(r.runId)}&kind=video`) }, '预览'),
                h(Btn, {
                  sm: true, disabled: Boolean(busy), onClick: () => remove(r),
                  style: delArm === r.runId ? { color: '#f87171', borderColor: 'rgba(248,113,113,.5)' } : undefined,
                }, busy === r.runId + 'del' ? '删除中…' : delArm === r.runId ? '确认删除？' : '删除成片')),
              h('div', { 'data-wb-row': '' },
                h(Btn, { sm: true, disabled: Boolean(busy) || !r.hasVideo || r.stage === 'uploading', onClick: () => upload(r, true) }, '投稿检查'),
                r.stage === 'approved'
                  ? h(Btn, { sm: true, disabled: Boolean(busy) || !publishEnabled || !r.hasVideo, onClick: () => upload(r, false) }, '提交投稿')
                  : null,
                h('div', { 'data-wb-grow': '' }),
                published ? h(Btn, { sm: true, disabled: Boolean(busy) || r.stage === 'uploading', onClick: () => syncPublication(r) }, '同步平台状态') : null,
                r.stage === 'upload_unknown' ? h(Btn, { sm: true, disabled: Boolean(busy), onClick: () => allowRetry(r) }, '确认未投稿后重试') : null,
                r.review?.state ? h('span', { 'data-wb-meta': '' }, '本地审核：' + (r.review.state === 'approved' ? '已通过' : r.review.state === 'rejected' ? '已打回' : r.review.state === 'published' ? '历史投稿记录待核对' : r.review.state)) : null),
              r.upload?.platformDescription ? h(Note, {}, '平台：' + r.upload.platformDescription + (r.upload.private ? ' · 仅自己可见' : '')) : null,
              r.upload?.rejectReason ? h(Err, {}, String(r.upload.rejectReason)) : null,
              r.stage === 'approved' && r.upload?.error ? h(Err, {}, '投稿未提交：' + r.upload.error) : null,
              r.stage === 'upload_unknown' ? h(Err, {}, '上次投稿结果未确认，请先核对创作中心或同步BV，避免重复投稿。') : null))
        })),
        preview ? h('div', { 'data-wb-overlay': '', role: 'dialog', 'aria-modal': true, 'aria-label': '成片预览', onClick: e => { if (e.target === e.currentTarget) setPreview('') } },
          h('button', { className: 'x', 'aria-label': '关闭预览（Esc）', onClick: () => setPreview('') }, '✕'),
          h('video', { src: preview, controls: true, autoPlay: true })) : null)
    }

    /* ═══════════════════ 我的 → 记忆 ═══════════════════ */
    function MemorySec() {
      const [data, setData] = useState(null)
      const [inputs, setInputs] = useState({ user: '', memory: '' })
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const cfgRes = useApi('/config')
      const cfg = cfgRes.data?.config

      const refresh = async () => {
        const r = await jget('/memory')
        if (r.ok) setData(r)
      }
      useEffect(() => { refresh() }, [])
      const op = async (o, note) => {
        setBusy('op'); setMsg('')
        const r = await jpost('/memory/op', o)
        setBusy('')
        if (!r.ok) setMsg(String(r.error || r.result?.error || '操作失败').split('\n')[0])
        else if (note) setMsg(note)
        refresh()
      }
      const toggleMemory = async (on) => {
        setBusy('toggle')
        const r = await jpost('/config', { memoryEnabled: on })
        setBusy('')
        if (r.ok) cfgRes.reload()
      }
      const toggleReflect = async (on) => {
        setBusy('reflect-toggle')
        const r = await jpost('/config', { reflectEnabled: on })
        setBusy('')
        if (r.ok) cfgRes.reload()
      }
      const runReflectNow = async () => {
        setBusy('reflect'); setMsg('复盘中…（翻最近的经历，提炼你的习惯）')
        const r = await jpost('/memory/reflect', {})
        setBusy('')
        if (r.ok) setMsg(`复盘完成：新记 ${r.added} 条${r.results?.some((x) => x.skipped) ? '（有候选被拦截）' : ''}`)
        else setMsg(String(r.skipped || r.error || '复盘未执行').split('\n')[0])
        refresh()
      }
      const evIcon = { watched: '观看', plan: '方案', 'plan-revise': '改版', render: '渲染', review: '审核', comment: '评论', reply: '回复', dm: '私信', publish: '投稿', task: '任务', remember: '记忆' }
      const pendings = data?.pending || []
      const events = data?.events || { count: 0, types: {}, recent: [] }

      const col = (key, title, hint) => {
        const t = data?.[key]
        return h('div', { 'data-wb-col': '', style: { minWidth: '0' } },
          h('div', { 'data-wb-row': '' },
            h('b', {}, title),
            h('div', { 'data-wb-grow': '' }),
            h(Chip, {}, `${t?.entries?.length ?? 0} 条 · ${t?.used ?? 0}/${t?.limit ?? 0} 字`)),
          h(Note, {}, hint),
          t?.error ? h('div', { 'data-wb-err': '' }, t.error) : null,
          h('div', { style: { display: 'flex', gap: '6px', margin: '6px 0' } },
            h('input', {
              'data-wb-input': '', style: { flex: '1', minWidth: '0' }, value: inputs[key],
              placeholder: key === 'user' ? '例：标题别超过 18 个字' : '例：1080p 渲染并发 4 会 OOM，用 2',
              onChange: (e) => setInputs({ ...inputs, [key]: e.target.value }),
              onKeyDown: async (e) => {
                if (e.key === 'Enter' && inputs[key]?.trim()) {
                  const v = inputs[key].trim()
                  setInputs({ ...inputs, [key]: '' })
                  await op({ target: key, action: 'add', content: v }, '已记下')
                }
              },
            }),
            h(Btn, {
              sm: true, disabled: busy === 'op' || !inputs[key]?.trim(),
              onClick: async () => { const v = inputs[key].trim(); await op({ target: key, action: 'add', content: v }, '已记下'); setInputs({ ...inputs, [key]: '' }) },
            }, '记一条')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            (t?.entries || []).map((e, i) => h('div', {
              key: i, 'data-wb-row': '',
              style: e.blocked ? { color: '#ef4444', borderBottom: '1px dashed #ef4444', padding: '2px 0' } : { borderBottom: '1px solid rgba(128,128,128,.2)', padding: '2px 0' },
              title: e.blocked ? `已屏蔽：${e.blockedWhy}（磁盘原文保留）` : `${e.source || ''} ${e.at ? '· ' + e.at.slice(0, 10) : ''}`,
            },
            h('span', { style: { flex: '1', minWidth: '0' } }, e.blocked ? `⛔ ${e.text}` : e.text),
            h('button', {
              'data-wb-ghost': '', style: { border: 'none', background: 'none', cursor: 'pointer', color: '#999' },
              title: '删除这条', onClick: () => op({ target: key, action: 'remove', old_text: e.text }, '已删'),
            }, '×')))),
          !t?.entries?.length && !t?.error ? h(Note, {}, '（空）') : null)
      }

      return h(Sec, { title: '记忆（长期偏好 / 工作台事实 / 经历）' },
        h('div', { 'data-wb-row': '' },
          h('label', { 'data-wb-toggle': '' },
            h('input', { type: 'checkbox', checked: cfg?.memoryEnabled !== false, disabled: busy === 'toggle', onChange: (e) => toggleMemory(e.target.checked) }),
            h('span', {}, '开启长期记忆（写评论 / 出方案时自动带上）')),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { sm: true, onClick: refresh }, '刷新'),
          msg ? h('span', { 'data-wb-note': '' }, msg) : null),
        h(Note, {}, `文件在 ${data?.dir || '素材库/memory/'}（USER.md = 主人偏好，MEMORY.md = 工作台事实；纯文本可手改，条目用 § 分隔）。主人在评论区说「记住：…」会自动进 USER.md；普通人的「记住」不会采纳。红色 ⛔ = 命中注入扫描，注入时已屏蔽。`),
        h('div', { 'data-wb-grid': '', style: { gridTemplateColumns: 'repeat(2,minmax(0,1fr))', marginTop: '6px' } },
          col('user', '主人画像（USER.md）', '老弟的口味：称呼、标题长度、封面偏好、禁用梗'),
          col('memory', '工作台笔记（MEMORY.md）', '环境的坑：B站限制、渲染参数、恢复办法')),
        /* ── 经历流（events.jsonl）：咕嘎自动记录的「看过/做过/结果」，创作时按题材召回 ── */
        h('div', { style: { marginTop: '10px' } },
          h('div', { 'data-wb-row': '' },
            h('b', {}, `经历流（${events.count} 条）`),
            h('div', { 'data-wb-grow': '' }),
            h(Chip, {}, Object.entries(events.types || {}).map(([t, n]) => `${evIcon[t] || '·'}${n}`).join(' ') || '还没有')),
          h(Note, {}, '咕嘎自动记录：看过什么、出过什么方案、渲染/审核/评论结果。出方案和写评论时会按题材把相关经历想起来；保留 90 天 / 上限条数。')),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '4px' } },
          (events.recent || []).map((e, i) => h('div', {
            key: i, 'data-wb-row': '', style: { borderBottom: '1px solid rgba(128,128,128,.15)', padding: '2px 0' },
            title: `${e.at} · ${e.type}`,
          },
          h('span', { style: { marginRight: '6px' } }, evIcon[e.type] || '·'),
          h('span', { 'data-wb-grow': '', style: { minWidth: '0' } }, String(e.text || '').slice(0, 70)),
          h('span', { style: { color: '#999', fontSize: '12px' } }, String(e.at || '').slice(5, 10))))),
        !events.recent?.length ? h(Note, {}, '（还没有经历，刷几条 B站 或出一个方案就有了）') : null,
        /* ── 复盘（M2）：从经历里提炼跨次有效的偏好 ── */
        h('div', { 'data-wb-row': '', style: { marginTop: '8px' } },
          h('label', { 'data-wb-toggle': '' },
            h('input', { type: 'checkbox', checked: cfg?.reflectEnabled !== false, disabled: busy === 'reflect-toggle', onChange: (e) => toggleReflect(e.target.checked) }),
            h('span', {}, '任务后自动复盘（从经历里提炼你的习惯，只增不改）')),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { sm: true, disabled: busy === 'reflect', onClick: runReflectNow }, '立即复盘'),
          data?.reflect?.lastAt ? h('span', { 'data-wb-note': '' }, `上次 ${String(data.reflect.lastAt).slice(5, 16).replace('T', ' ')} · 累计新记 ${data.reflect.added || 0} 条`) : null),
        pendings.length ? h('div', { style: { marginTop: '8px' } },
          h('b', {}, `待批提案（${pendings.length}）`),
          h(Note, {}, '无人值守任务只能「记新条」，改动/删除会在这里等批准'),
          pendings.map((p) => h('div', { key: p.id, 'data-wb-row': '', style: { padding: '2px 0' } },
            h('span', { 'data-wb-grow': '' }, `#${p.id} ${p.target}.${p.action}：${(p.matched_entry || p.old_text || '').slice(0, 40)}${p.new_text ? ' → ' + p.new_text.slice(0, 30) : ''}`),
            h(Btn, { sm: true, onClick: async () => { await jpost('/memory/pending/approve', { id: p.id }); refresh() } }, '批准'),
            h(Btn, { sm: true, onClick: async () => { await jpost('/memory/pending/discard', { id: p.id }); refresh() } }, '丢弃')))) : null)
    }

    /* ═══════════════════ ⑤ 我的 ═══════════════════ */
    function TabMine() {
      const [auth, setAuth] = useState(null)
      const [authLoading, setAuthLoading] = useState(true)
      const [authError, setAuthError] = useState('')
      const [qr, setQr] = useState(false)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [log, setLog] = useState('')
      const [health, setHealth] = useState('')
      const cfgRes = useApi('/config')
      const stats = useApi('/stats')
      const cfg = cfgRes.data?.config
      const [draft, setDraft] = useState(null)

      const refreshAuth = async () => {
        setAuthLoading(true); setAuthError('')
        const r = await jget('/status')
        if (r.ok) setAuth(r)
        else setAuthError(errText(r) || '登录状态查询失败')
        setAuthLoading(false)
      }
      useEffect(() => { refreshAuth() }, [])
      useEffect(() => {
        if (cfg && draft === null) setDraft({ publishEnabled: cfg.publishEnabled, tagsText: (cfg.defaultTags || []).join(','), defaultZone: cfg.defaultZone })
      }, [cfg, draft])
      usePoll(async () => {
        const r = await jget('/status')
        if (r.ok) { setAuth(r); if (r.loggedIn) setQr(false) }
      }, 2500, qr)

      const login = async () => {
        setBusy('login'); setMsg('生成二维码…')
        const r = await jpost('/login/start')
        setBusy('')
        if (r.ok) { setQr(true); setMsg('手机 B站 扫码，确认时选「记住我 / 长期」') }
        else setMsg('生成二维码失败：' + (errText(r) || ''))
      }
      const logout = async () => {
        setBusy('logout')
        await jpost('/logout')
        setBusy(''); setQr(false); refreshAuth()
      }
      const showLog = async () => {
        setBusy('log')
        const r = await jget('/duty-log')
        setBusy(''); setLog(r.ok ? (r.text || '（空）') : ('读取失败：' + (errText(r) || '')))
      }
      const checkModel = async () => {
        setBusy('model')
        const r = await jget('/model/health')
        setBusy('')
        setHealth(JSON.stringify(r.data || { error: r.error }, null, 2))
      }
      const savePublish = async () => {
        if (!draft) return
        setBusy('save')
        const r = await jpost('/config', {
          publishEnabled: draft.publishEnabled,
          defaultTags: String(draft.tagsText || '').split(',').map((s) => s.trim()).filter(Boolean),
          defaultZone: draft.defaultZone,
        })
        setBusy('')
        setMsg(r.ok ? '发布设置已保存' : ('保存失败：' + (errText(r) || '')))
        cfgRes.reload()
      }
      const d = stats.data?.data
      const n = (o, k) => (o && Number.isFinite(Number(o[k])) ? Number(o[k]) : 0)
      const store = cfgRes.data?.store || {}
      const [storePath, setStorePath] = useState('')
      useEffect(() => { if (store.path) setStorePath(store.path) }, [store.path])
      const relocate = async () => {
        const p = String(storePath || '').trim()
        if (!p) { setMsg('先填一个素材库目录'); return }
        setBusy('store'); setMsg('切换素材库位置中…')
        const r = await jpost('/store/relocate', { path: p, copy: true })
        setBusy('')
        if (r.ok) {
          setMsg(`已切换 · ${r.path} · ${r.store?.videos ?? 0} 条${r.copied ? '（已复制现有素材）' : ''}`)
          setStorePath(r.path || p)
          cfgRes.reload(); stats.reload()
        } else setMsg('切换失败：' + (errText(r) || ''))
      }

      return h('div', { 'data-wb-page': '' },
        h(PageHead, { title: '我的', sub: '登录、用户信息、账号数据、全局设置' },
          authLoading || !auth || auth.loggedIn ? null : h(Btn, { primary: true, sm: true, disabled: busy === 'login', onClick: login }, busy === 'login' ? '生成二维码…' : '扫码登录')),

        authLoading || !auth
          ? h(Sec, {},
            h('div', { role: 'status', 'aria-live': 'polite', 'data-wb-note': '' }, authLoading ? '正在确认登录状态…' : '暂时无法确认登录状态'),
            h(Err, {}, authError),
            !authLoading ? h(Btn, { sm: true, onClick: refreshAuth }, '重新查询') : null)
          : !auth.loggedIn
          ? h('div', { 'data-wb-login': '' },
            h('div', { 'data-wb-qr': '' }, qr ? h('img', { src: API + '/qr.png?t=' + Date.now(), alt: '二维码' }) : h('div', { className: 'ph' })),
            h('div', { 'data-wb-col': '', style: { flex: 1 } },
              h('div', { 'data-wb-projtitle': '' }, '扫码登录 bili-cli'),
              h(Note, {}, '手机 B站 App 扫码，确认时选「记住我 / 长期」。登录成功后这里会变成：昵称 · UID · LV · 登出按钮。'),
              h('div', { 'data-wb-row': '' },
                h(Chip, { warn: true }, '未登录'),
                h(Btn, { sm: true, disabled: busy === 'login', onClick: login }, qr ? '刷新二维码' : '生成二维码'),
                msg ? h('span', { 'data-wb-note': '' }, msg) : null),
              h(Note, {}, '工作台统一用这一份登录；别再装老「刷B站」插件，会有两套账。')))
          : h(Sec, {},
            h('div', { 'data-wb-row': '' },
              h(Chip, { ok: true }, `已登录 · ${auth.user?.name || auth.user?.mid || ''} · LV${auth.user?.level ?? '?'}`),
              h(Chip, {}, `UID ${auth.user?.mid ?? '-'}`),
              h('div', { 'data-wb-grow': '' }),
              h(Btn, { sm: true, onClick: refreshAuth }, '刷新'),
              h(Btn, { sm: true, disabled: busy === 'logout', onClick: logout }, '登出'))),

        d ? h('div', { 'data-wb-grid': '', style: { gridTemplateColumns: 'repeat(2,minmax(0,1fr))' } },
          h('div', { 'data-wb-stat': '' }, h('b', {}, fmtNum(n(d.plays, 'now'))), h('span', {}, `播放 · 上期 ${fmtNum(n(d.plays, 'previous'))}`)),
          h('div', { 'data-wb-stat': '' }, h('b', {}, fmtNum(n(d.visitors, 'now'))), h('span', {}, '访客')),
          h('div', { 'data-wb-stat': '' }, h('b', {}, `+${fmtNum(n(d.new_fans, 'now'))}`), h('span', {}, `涨粉 · 总粉丝 ${fmtNum(d.fans?.total)}`)),
          h('div', { 'data-wb-stat': '' }, h('b', {}, `${d.beats_similar_ups_percent?.play ?? '-'}%`), h('span', {}, '播放超过同类 UP'))) : null,

        h('div', { 'data-wb-split': '' },
          h(Sec, { title: '素材库与运行' },
            h('div', { 'data-wb-kv': '' },
              `库路径：${store.path || '—'}`,
              h('br'),
              `库内：${store.videos ?? '-'} 条 · ${store.mb ?? '-'} MB · ${store.files ?? '-'} 个文件`,
              h('br'),
              `定时：${cfg?.enabled ? '开' : '关'}（${cfg?.scheduleRanges || '00:00-24:00'} · 每天上限 ${cfg?.perDay || 48} · 约每 ${cfgRes.data?.schedule?.estMinutes || '?'} 分钟 1 条）`,
              h('br'),
              `模型链：${(cfg?.modelChain || []).length} 个，当前 ${(cfg?.modelChain || [])[0] || '-'}`),
            h(Field, { label: '素材库位置' },
              h('input', {
                'data-wb-input': '', style: { maxWidth: '430px' }, value: storePath,
                placeholder: '~/.dsh-bili-workbench/store',
                onChange: (e) => setStorePath(e.target.value),
              }),
              h(Btn, { sm: true, disabled: busy === 'store', onClick: relocate }, busy === 'store' ? '切换中…' : '保存并切换'),
              h(Note, {}, '默认 ~/.dsh-bili-workbench/store；新目录为空时会复制现有素材，已有数据则直接切换')),
            h('div', { 'data-wb-row': '' },
              h(Btn, { sm: true, disabled: busy === 'log', onClick: showLog }, '看运行日志'),
              h(Btn, { sm: true, onClick: () => jpost('/open-folder', { what: 'store' }) }, '打开库目录'),
              h(Btn, { sm: true, onClick: () => jpost('/open-folder', { what: 'runs' }) }, '打开成片目录'),
              h(Btn, { sm: true, disabled: busy === 'model', onClick: checkModel }, '测模型')),
            health ? h('pre', { 'data-wb-pre': '' }, health) : null,
            log ? h('pre', { 'data-wb-pre': '' }, log) : null),

          h(Sec, { title: '发布权限（提交投稿）' },
            h('label', { 'data-wb-toggle': '' },
              h('input', { type: 'checkbox', checked: Boolean(draft?.publishEnabled), onChange: (e) => setDraft({ ...draft, publishEnabled: e.target.checked }) }),
              h('span', {}, '允许提交投稿（默认关）')),
            h(Note, {}, '关着的时候，「成片投稿」只能检查投稿参数；打开后仍会二次确认。'),
            h(Field, { label: '默认标签' },
              h('input', { 'data-wb-input': '', value: draft?.tagsText || '', onChange: (e) => setDraft({ ...draft, tagsText: e.target.value }), placeholder: 'AI,资讯,盘点' })),
            h(Field, { label: '默认分区 ID' },
              h('input', { 'data-wb-input': '', 'data-num': '', type: 'number', value: draft?.defaultZone ?? 0, onChange: (e) => setDraft({ ...draft, defaultZone: e.target.value }) }),
              h(Note, {}, '0 = 让 bili 自动预测')),
            h('div', { 'data-wb-row': '' },
              h(Btn, { sm: true, primary: true, disabled: busy === 'save', onClick: savePublish }, '保存发布设置'),
              msg ? h('span', { 'data-wb-note': '' }, msg) : null)),

          h(Sec, { title: '模型链' },
            h('div', { 'data-wb-kv': '' }, (cfg?.modelChain || []).map((m, i) => h('div', { key: i }, `${i + 1}. ${m}`))),
            h(Note, {}, '在「刷B站设置 → 模型链」里改。失败自动换下一个。')),

          h(MemorySec),
          h(Err, {}, cfgRes.err)))
    }

    /* ═══════════════════ 外壳 ═══════════════════ */
    const NAV = [
      ['store', 'store', '素材库'],
      ['scroll', 'scroll', '刷B站'],
      ['create', 'create', '创作中心'],
      ['review', 'review', '成片投稿'],
      ['settings', 'settings', '刷B站设置'],
      ['mine', 'mine', '我的'],
    ]

    function Shell() {
      const [tab, setTab] = useState(() => { try { return sessionStorage.getItem('bili-wb-tab') || 'store' } catch { return 'store' } })
      useEffect(() => { try { sessionStorage.setItem('bili-wb-tab', tab) } catch {} }, [tab])
      const [collapsed, setCollapsed] = useState(false)
      const rootRef = useRef(null)
      // 让工作台高度跟着宿主“可用区 - 输入区”走，避免外层再多一条滚动条
      React.useLayoutEffect(() => {
        const root = rootRef.current
        if (!root) return
        const findScroll = () => {
          let el = root.parentElement
          while (el) {
            const s = getComputedStyle(el)
            if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.clientHeight > 0) return el
            el = el.parentElement
          }
          return null
        }
        const seatOf = (scroll) => scroll?.querySelector('[class*="composerSeat"]') || null
        let seat = null
        const fit = () => {
          const scroll = findScroll()
          if (!scroll) return
          seat = seatOf(scroll)
          const seatH = seat ? seat.offsetHeight : 0
          const avail = Math.max(320, scroll.clientHeight - seatH)
          root.style.height = avail + 'px'
          root.style.maxHeight = avail + 'px'
          root.style.minHeight = '0px'
        }
        fit()
        const ro = new ResizeObserver(() => fit())
        ro.observe(document.documentElement)
        const scroll = findScroll()
        if (scroll) ro.observe(scroll)
        if (seat) ro.observe(seat)
        window.addEventListener('resize', fit)
        const t = setTimeout(fit, 500)
        // 宿主切换会话 / 输入框变高时，再量一次
        const iv = setInterval(fit, 1500)
        return () => { clearTimeout(t); clearInterval(iv); ro.disconnect(); window.removeEventListener('resize', fit) }
      }, [])
      return h('div', { 'data-wb-root': '', 'data-collapsed': collapsed ? '' : undefined, ref: rootRef },
        h('aside', { 'data-wb-rail': '' },
          h('div', { 'data-wb-brand': '' }, 'B站工作台', h('small', {}, '素材 → 出片 → 发布')),
          h('nav', { style: { display: 'flex', flexDirection: 'column' } },
            ...NAV.map(([k, ico, label]) => h('button', {
              key: k, 'data-wb-nav': '', 'aria-label': label, title: label, 'aria-selected': tab === k ? 'true' : 'false',
              onClick: () => setTab(k),
            },
            h('span', { className: 'ico' }, h(Icon, { name: ico })),
            h('span', { 'data-wb-label': '' }, label)))),
          h('div', { 'data-wb-rail-foot': '' },
            h('button', { 'data-wb-ghost': '', onClick: () => setCollapsed(!collapsed) }, collapsed ? '»' : '« 收起'))),
        h('main', { 'data-wb-main': '' },
          tab === 'store' ? h(TabStore) : null,
          tab === 'scroll' ? h(TabScroll) : null,
          tab === 'create' ? h(TabCreate) : null,
          tab === 'review' ? h(TabReview) : null,
          tab === 'settings' ? h(TabScrollSettings) : null,
          tab === 'mine' ? h(TabMine) : null))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-bili-workbench')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-bili-workbench: 样式')
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        try {
          slots.inject('conversation.view', () => slots.register({
            name: 'conversation.view', id: 'bili-wb', order: 30, label: 'B站工作台', scope: 'session',
          }, () => h(Shell)))
        } catch (e) { /* 没有这个槽位就算了 */ }
      },
    }
  },
})
