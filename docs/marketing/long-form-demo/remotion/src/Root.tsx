import React from "react";
import { Composition } from "remotion";
import { OverlayDemo } from "./OverlayDemo";
import { HighlightReel } from "./HighlightReel";
import { FPS } from "./brand";
import { HIGHLIGHT_DURATION_FRAMES } from "./timeline";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="OverlayDemo"
        component={OverlayDemo}
        durationInFrames={90}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{
          title: "Replace Loom for free",
          subtitle: "Chrome + macOS · camera PiP · no subscription",
          variant: "orange" as const,
        }}
      />
      <Composition
        id="HighlightReel"
        component={HighlightReel}
        durationInFrames={HIGHLIGHT_DURATION_FRAMES}
        fps={FPS}
        width={1920}
        height={1080}
      />
    </>
  );
};
