import React from "react";
import { Composition } from "remotion";
import { OverlayDemo } from "./OverlayDemo";
import { HighlightReel } from "./HighlightReel";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="OverlayDemo"
        component={OverlayDemo}
        durationInFrames={90}
        fps={30}
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
        // ~5m05 clips + 8s end card @ 30fps (305s + 8s)
        durationInFrames={30 * 313}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
