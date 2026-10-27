import React from "react";
import {
  AbsoluteFill,
  Img,
  Sequence,
  Video,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

/**
 * 资讯盘点模板 —— 4 种镜头：title / item / data / outro
 * 数据全部来自 props.json（bili-op/tts.mjs 产出），这里只负责画。
 */

const FONT = 'Microsoft YaHei, "Segoe UI", "Noto Sans SC", sans-serif';
const ACCENT = "#5B8CFF";
const ACCENT2 = "#A78BFA";
const GREEN = "#34D399";
const DIM = "rgba(255,255,255,0.66)";

/* ───────────── 背景 ───────────── */
const Bg: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame / 30;
  const x1 = 28 + Math.sin(t * 0.35) * 6;
  const y1 = 22 + Math.cos(t * 0.28) * 5;
  const x2 = 74 + Math.cos(t * 0.22) * 6;
  const y2 = 78 + Math.sin(t * 0.31) * 5;
  return (
    <AbsoluteFill style={{ background: "linear-gradient(160deg,#080c18 0%,#0b1020 45%,#0a0f1e 100%)" }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(46% 42% at ${x1}% ${y1}%, rgba(91,140,255,0.28), transparent 70%)`,
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(44% 40% at ${x2}% ${y2}%, rgba(167,139,250,0.22), transparent 70%)`,
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "repeating-linear-gradient(0deg, rgba(255,255,255,0.028) 0 1px, transparent 1px 44px)",
        }}
      />
    </AbsoluteFill>
  );
};

/* ───────────── 通用动画 ───────────── */
const useAnim = (frames: number) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 18, mass: 0.6 } });
  const out = interpolate(frame, [frames - 10, frames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return {
    opacity: Math.min(enter, out),
    y: interpolate(enter, [0, 1], [28, 0]),
    scale: interpolate(enter, [0, 1], [0.97, 1]),
  };
};

/* ───────────── 顶栏 / 进度 ───────────── */
const TopBar: React.FC<{ label: string; right?: string }> = ({ label, right }) => (
  <div style={{ position: "absolute", top: 56, left: 88, right: 88, display: "flex", alignItems: "center" }}>
    <div
      style={{
        padding: "10px 22px",
        borderRadius: 999,
        background: "rgba(91,140,255,0.18)",
        border: "1px solid rgba(91,140,255,0.5)",
        color: "#cfe0ff",
        fontSize: 26,
        fontWeight: 700,
        letterSpacing: 1,
      }}
    >
      {label}
    </div>
    <div style={{ flex: 1 }} />
    <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 24, fontFamily: FONT }}>{right || ""}</div>
  </div>
);

const Progress: React.FC<{ total: number }> = ({ total }) => {
  const frame = useCurrentFrame();
  const p = Math.max(0, Math.min(1, frame / Math.max(1, total - 1)));
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 6, background: "rgba(255,255,255,0.08)" }}>
      <div
        style={{
          width: `${p * 100}%`,
          height: "100%",
          background: `linear-gradient(90deg,${ACCENT},${ACCENT2})`,
        }}
      />
    </div>
  );
};

/* ───────────── 四种镜头 ───────────── */
const TitleShot: React.FC<{ s: any; frames: number }> = ({ s, frames }) => {
  const a = useAnim(frames);
  return (
    <AbsoluteFill style={{ opacity: a.opacity }}>
      <div
        style={{
          position: "absolute",
          left: 88,
          right: 88,
          top: 300,
          transform: `translateY(${a.y}px) scale(${a.scale})`,
          fontFamily: FONT,
        }}
      >
        <div style={{ color: ACCENT, fontSize: 30, fontWeight: 700, letterSpacing: 3, marginBottom: 26 }}>
          {s.kicker || ""}
        </div>
        <div style={{ color: "#fff", fontSize: 104, fontWeight: 800, lineHeight: 1.12, letterSpacing: -1 }}>
          {s.headline || String(s.narration || "").slice(0, 22)}
        </div>
        <div style={{ color: DIM, fontSize: 40, marginTop: 34 }}>{s.sub}</div>
      </div>
    </AbsoluteFill>
  );
};

const ItemShot: React.FC<{ s: any; frames: number; total: number }> = ({ s, frames, total }) => {
  const a = useAnim(frames);
  const frame = useCurrentFrame();
  const hasFrame = Boolean(s.frameImage) || Boolean(s.footage?.file);
  const hasFootage = Boolean(s.footage?.file);
  return (
    <AbsoluteFill style={{ opacity: a.opacity }}>
      <div
        style={{
          position: "absolute",
          left: 88,
          right: 88,
          top: hasFrame ? 214 : 250,
          display: "flex",
          gap: hasFrame ? 46 : 56,
          alignItems: "center",
        }}
      >
        <div
          style={{
            fontFamily: FONT,
            fontSize: hasFrame ? 170 : 220,
            fontWeight: 800,
            lineHeight: 1,
            letterSpacing: -6,
            background: `linear-gradient(180deg,${ACCENT},${ACCENT2})`,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            transform: `translateY(${a.y}px)`,
          }}
        >
          {String(s.index || "").padStart(2, "0")}
        </div>
        <div style={{ flex: 1, minWidth: 0, transform: `translateY(${a.y}px)`, fontFamily: FONT }}>
          {s.badge ? (
            <div
              style={{
                display: "inline-block",
                padding: "8px 18px",
                borderRadius: 10,
                background: "rgba(52,211,153,0.16)",
                border: "1px solid rgba(52,211,153,0.5)",
                color: GREEN,
                fontSize: 24,
                fontWeight: 700,
                marginBottom: 24,
              }}
            >
              {s.badge}
            </div>
          ) : null}
          <div style={{ color: "#fff", fontSize: hasFrame ? 64 : 76, fontWeight: 800, lineHeight: 1.18, letterSpacing: -1 }}>
            {s.headline || String(s.narration || "").slice(0, 22)}
          </div>
          <div style={{ color: DIM, fontSize: hasFrame ? 34 : 38, lineHeight: 1.5, marginTop: 26 }}>{s.body}</div>
        </div>
        {hasFrame ? (
          <div
            style={{
              width: 560,
              flex: "none",
              borderRadius: 24,
              overflow: "hidden",
              border: "1px solid rgba(255,255,255,0.18)",
              boxShadow: "0 28px 70px rgba(0,0,0,0.5)",
              background: "#0d1424",
              transform: `scale(${a.scale})`,
            }}
          >
            <div
              style={
                s.effect === "kenburns" && !hasFootage
                  ? {
                      // 缓慢推近：整镜内 scale 1.0 → 1.10，加一点横向漂移
                      height: "100%",
                      transform: `scale(${1 + (frame / Math.max(1, frames)) * 0.1}) translateX(${(frame / Math.max(1, frames)) * -12}px)`,
                      transformOrigin: "center",
                    }
                  : undefined
              }
            >
              {hasFootage ? (
                <Video
                  src={staticFile(s.footage.file)}
                  startFrom={Math.round((Number(s.footage.offset) || 0) * 30)}
                  muted
                  style={{ width: "100%", display: "block" }}
                />
              ) : (
                <Img src={staticFile(s.frameImage)} style={{ width: "100%", display: "block" }} />
              )}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 16px",
                color: "rgba(255,255,255,0.55)",
                fontSize: 18,
                fontFamily: FONT,
                background: "rgba(255,255,255,0.04)",
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: 99, background: ACCENT, display: "inline-block" }} />
              素材画面 · {s.frameFrom?.bv || ""}
              {Number.isFinite(Number(s.frameFrom?.t)) ? ` · ${Math.round(Number(s.frameFrom.t))}s` : ""}
            </div>
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

const DataShot: React.FC<{ s: any; frames: number }> = ({ s, frames }) => {
  const a = useAnim(frames);
  const stats = Array.isArray(s.stats) ? s.stats : [];
  return (
    <AbsoluteFill style={{ opacity: a.opacity }}>
      <div style={{ position: "absolute", left: 88, right: 88, top: 260, fontFamily: FONT }}>
        <div style={{ color: "#fff", fontSize: 68, fontWeight: 800, marginBottom: 56, transform: `translateY(${a.y}px)` }}>
          {s.headline || String(s.narration || "").slice(0, 22)}
        </div>
        <div style={{ display: "flex", gap: 28 }}>
          {stats.map((x: any, i: number) => (
            <div
              key={i}
              style={{
                flex: 1,
                padding: "38px 34px",
                borderRadius: 22,
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.12)",
              }}
            >
              <div
                style={{
                  fontSize: 72,
                  fontWeight: 800,
                  background: `linear-gradient(180deg,${ACCENT},${ACCENT2})`,
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                }}
              >
                {x.value}
              </div>
              <div style={{ color: DIM, fontSize: 28, marginTop: 10 }}>{x.label}</div>
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* 小剧场：双角色 + 对话气泡（台词随镜头时长均分切换） */
const SceneShot: React.FC<{ s: any; frames: number }> = ({ s, frames }) => {
  const frame = useCurrentFrame();
  const lines = Array.isArray(s.lines) ? s.lines : [];
  const lineIdx = Math.min(lines.length - 1, Math.floor((frame / Math.max(1, frames)) * lines.length));
  const line = lines[lineIdx] || { who: "L", text: "" };
  const activeL = line.who === "L";
  const bob = (on: boolean) => (on ? `translateY(${Math.sin(frame / 4) * 8}px) scale(1.04)` : "translateY(0) scale(1)");
  return (
    <AbsoluteFill>
      <TopBar label="咕嘎小剧场" right={s.headline || ""} />
      <div style={{ position: "absolute", top: 150, left: 0, right: 0, textAlign: "center", fontFamily: FONT }}>
        <div style={{ display: "inline-block", padding: "10px 28px", borderRadius: 14, background: "rgba(91,140,255,0.16)", border: "1px solid rgba(91,140,255,0.5)", color: "#cfe0ff", fontSize: 34, fontWeight: 700 }}>
          {s.headline || String(s.narration || "").slice(0, 22)}
        </div>
      </div>
      {/* 气泡：跟着说话人 */}
      <div style={{
        position: "absolute", top: 300,
        left: activeL ? 220 : undefined, right: activeL ? undefined : 220,
        maxWidth: 640, padding: "22px 30px", borderRadius: 20,
        background: "rgba(255,255,255,0.94)", color: "#1a2233",
        fontSize: 36, fontWeight: 600, lineHeight: 1.45, fontFamily: FONT,
        boxShadow: "0 18px 44px rgba(0,0,0,0.4)",
      }}>
        {line.text}
        <div style={{ fontSize: 22, color: "#8593ad", marginTop: 8 }}>{activeL ? "—— 咕嘎" : "—— 小狗"}</div>
      </div>
      {/* 角色 */}
      <Img src={staticFile(s.left || "mascot/default.png")} style={{ position: "absolute", left: 170, bottom: 200, width: 300, height: 300, opacity: activeL ? 1 : 0.62, transform: bob(activeL), filter: "drop-shadow(0 16px 34px rgba(0,0,0,0.45))", transition: "opacity 200ms" }} />
      <Img src={staticFile(s.right || "mascot/partner.png")} style={{ position: "absolute", right: 170, bottom: 200, width: 300, height: 300, opacity: activeL ? 0.62 : 1, transform: bob(!activeL), filter: "drop-shadow(0 16px 34px rgba(0,0,0,0.45))" }} />
    </AbsoluteFill>
  );
};

const OutroShot: React.FC<{ s: any; frames: number }> = ({ s, frames }) => {
  const a = useAnim(frames);
  return (
    <AbsoluteFill style={{ opacity: a.opacity }}>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", fontFamily: FONT }}>
        <div style={{ transform: `translateY(${a.y}px) scale(${a.scale})`, textAlign: "center" }}>
          <div style={{ color: "#fff", fontSize: 90, fontWeight: 800 }}>{s.headline || String(s.narration || "").slice(0, 22)}</div>
          <div style={{ color: DIM, fontSize: 36, marginTop: 30 }}>{s.sub}</div>
          <div
            style={{
              display: "inline-block",
              marginTop: 54,
              padding: "14px 34px",
              borderRadius: 999,
              background: "rgba(91,140,255,0.16)",
              border: "1px solid rgba(91,140,255,0.5)",
              color: "#cfe0ff",
              fontSize: 28,
              fontWeight: 700,
            }}
          >
            关注 · 下周接着聊
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* ───────────── 转场（入场动画）+ 持续动效 ─────────────
 * 转场只做「进入这一镜」的前 T 帧动画，由方案里每镜的 transition 字段驱动（plan.mjs 白名单）。
 * blinds 用 8 根竖条帘幕收起实现；wipe 用 clip-path 从右往左揭开；其余是位移/缩放/模糊。
 */
const T_FRAMES = 10;

const TransitionIn: React.FC<{
  type?: string;
  effect?: string;
  frames: number;
  children: React.ReactNode;
}> = ({ type = "fade", effect = "", frames, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = Math.max(0, Math.min(1, frame / T_FRAMES));          // 0→1 入场进度
  const e = spring({ frame, fps, config: { damping: 20, mass: 0.7 } });

  // 持续动效（整镜）：kenburns 留给素材图（ItemShot 内部处理）；shake/pulse 在这里
  // （提前算好：blinds 分支的 early return 也要把它应用到内容上）
  const dur = Math.max(1, frames);
  let fx = "";
  if (effect === "shake") fx = `translate(${Math.sin(frame * 1.7) * 3}px, ${Math.cos(frame * 2.1) * 2}px)`;
  else if (effect === "pulse") fx = `scale(${1 + Math.sin((frame / dur) * Math.PI * 2) * 0.012})`;

  let enter: React.CSSProperties = { opacity: type === "cut" ? 1 : t };
  if (type === "slide") enter = { opacity: t, transform: `translateX(${(1 - e) * -90}px)` };
  else if (type === "zoom") enter = { opacity: t, transform: `scale(${1 + (1 - e) * 0.12})` };
  else if (type === "dissolve") enter = { opacity: t, filter: `blur(${(1 - t) * 10}px)` };
  else if (type === "wipe") enter = { clipPath: `inset(0 ${(1 - e) * 100}% 0 0)` };
  else if (type === "blinds") {
    // 帘幕：8 根竖条依次收起，内容在下面
    const bars = Array.from({ length: 8 });
    return (
      <div style={{ position: "absolute", inset: 0 }}>
        <div style={{ position: "absolute", inset: 0, opacity: Math.min(1, t * 2), transform: fx || undefined }}>{children}</div>
        {bars.map((_, k) => {
          const delay = k * 0.8;
          const p = Math.max(0, Math.min(1, (frame - delay) / (T_FRAMES - 4)));
          return (
            <div
              key={k}
              style={{
                position: "absolute",
                top: 0,
                left: `${k * 12.5}%`,
                width: "12.6%",
                height: "100%",
                background: "#080c18",
                transformOrigin: "top",
                transform: `scaleY(${1 - p})`,
              }}
            />
          );
        })}
      </div>
    );
  }

  // 非 blinds 路径：入场 + 持续动效合并（fx 已在上面算好）
  const merged: React.CSSProperties = {
    ...enter,
    transform: [fx, enter.transform].filter(Boolean).join(" ") || undefined,
  };
  return <div style={{ position: "absolute", inset: 0, ...merged }}>{children}</div>;
};

/* ───────────── 形象图层 ───────────── */
/* 全屏 B-roll：真视频片段铺满整屏直接播放（轨道拼接模式，非画中画） */
const BrollShot: React.FC<{ s: any; frames: number }> = ({ s, frames }) => {
  if (!s.footage?.file) {
    return (
      <AbsoluteFill style={{ background: "#0d1424", justifyContent: "center", alignItems: "center", fontFamily: FONT }}>
        <div style={{ color: "#fff", fontSize: 64, fontWeight: 800 }}>{s.headline || String(s.narration || "").slice(0, 22)}</div>
        <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 30, marginTop: 20 }}>（片段缺失，已降级为标题卡）</div>
      </AbsoluteFill>
    );
  }
  const off = Math.round((Number(s.footage?.offset) || 0) * 30);
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Video
        src={staticFile(s.footage.file)}
        startFrom={off}
        muted
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
      />
      {/* 底部渐变 + 大字标题，保证信息还在 */}
      <div style={{ display: s.audioMode === "original" ? "none" : undefined, position: "absolute", left: 0, right: 0, bottom: 0, height: 240, background: "linear-gradient(transparent, rgba(0,0,0,0.72))" }} />
      <div style={{ display: s.audioMode === "original" ? "none" : undefined, position: "absolute", left: 88, right: 88, bottom: 96, fontFamily: FONT }}>
        <div style={{ color: "#fff", fontSize: 58, fontWeight: 800, textShadow: "0 4px 18px rgba(0,0,0,0.6)" }}>{s.headline || String(s.narration || "").slice(0, 22)}</div>
        {s.body ? <div style={{ color: "rgba(255,255,255,0.82)", fontSize: 30, marginTop: 14 }}>{s.body}</div> : null}
      </div>
    </AbsoluteFill>
  );
};

const MascotLayer: React.FC<{ src?: string; video?: string }> = ({ src, video }) => {
  const frame = useCurrentFrame();
  if (!src && !video) return null;
  const bob = Math.sin(frame / 34) * 10;              // 轻微上下浮动
  const a = spring({ frame, fps: 30, config: { damping: 14, mass: 0.8 } });  // 入场弹跳
  if (video) {
    return (
      <Video src={staticFile(video)} loop muted style={{
        position: "absolute", right: 96, bottom: 150,
        width: 260, height: 150,
        transform: `translateY(${bob}px) scale(${0.6 + a * 0.4})`,
        opacity: Math.min(1, a + 0.2),
        filter: "drop-shadow(0 14px 30px rgba(0,0,0,0.45))",
        zIndex: 50,
        borderRadius: 16,
        overflow: "hidden",
      }} />
    );
  }
  return (
    <Img src={staticFile(src)} style={{
      position: "absolute", right: 96, bottom: 150,
      width: 200, height: 200,
      transform: `translateY(${bob}px) scale(${0.6 + a * 0.4})`,
      opacity: Math.min(1, a + 0.2),
      filter: "drop-shadow(0 14px 30px rgba(0,0,0,0.45))",
      zIndex: 50,
    }} />
  );
};

/* ───────────── 主组件 ───────────── */
export const News: React.FC<any> = (p) => {
  const shots = Array.isArray(p?.shots) ? p.shots : [];
  const itemTotal = shots.filter((s: any) => s.kind === "item").length;
  const total = Number(p?.totalFrames) || 1;

  return (
    <AbsoluteFill style={{ background: "#080c18", fontFamily: FONT }}>
      <Bg />
      {shots.map((s: any, i: number) => (
        <Sequence key={i} from={Number(s.from) || 0} durationInFrames={Math.max(1, Number(s.frames) || 30)}>
          <TransitionIn type={s.transition} effect={s.effect} frames={Number(s.frames) || 30}>
            {s.kind === "title" ? <TitleShot s={s} frames={Number(s.frames) || 30} /> : null}
            {s.kind === "item" ? <ItemShot s={s} frames={Number(s.frames) || 30} total={itemTotal} /> : null}
            {s.kind === "data" ? <DataShot s={s} frames={Number(s.frames) || 30} /> : null}
            {s.kind === "outro" ? <OutroShot s={s} frames={Number(s.frames) || 30} /> : null}
            {s.kind === "scene" ? <SceneShot s={s} frames={Number(s.frames) || 30} /> : null}
            {s.kind === "broll" ? <BrollShot s={s} frames={Number(s.frames) || 30} /> : null}
            {s.overlay ? <div style={{ position: "absolute", top: 72, right: 80, maxWidth: 980, padding: "14px 24px", borderRadius: 14, background: "rgba(0,0,0,.7)", color: "#ffe36a", fontSize: 44, fontWeight: 800, fontFamily: FONT }}>{s.overlay}</div> : null}
            {s.kind === "broll" && s.source?.bv ? <div style={{ position: "absolute", right: 32, bottom: 24, background: "rgba(0,0,0,.6)", padding: "5px 10px", color: "#fff", fontSize: 20 }}>原片引用 · {s.source.bv}</div> : null}
          </TransitionIn>
        </Sequence>
      ))}
      <MascotLayer src={!p?.mascotVideo ? p?.mascot : undefined} video={p?.mascotVideo} />
      {p?.style === "B" ? null : <Progress total={total} />}
    </AbsoluteFill>
  );
};


