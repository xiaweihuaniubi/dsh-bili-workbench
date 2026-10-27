import { Composition } from "remotion";
import { News } from "./News";

/**
 * 一期「资讯盘点」= 一条 composition。
 * 时长/帧数来自 props.json（由 bili-op/tts.mjs 按真实配音时长算好）。
 */
export const RemotionRoot = () => (
  <Composition
    id="News"
    component={News as never}
    durationInFrames={2186}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={{
      title: "",
      subtitle: "",
      totalFrames: 2186,
      fps: 30,
      shots: [],
    }}
    calculateMetadata={({ props }: { props: any }) => ({
      durationInFrames: Math.max(30, Math.round(Number(props?.totalFrames) || 2186)),
      fps: 30,
      width: 1920,
      height: 1080,
    })}
  />
);
