import React from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Captions } from "./Captions";
import { GlassCard } from "./GlassCard";
import { panelSpring } from "./motion";
import { PushOverPanel } from "./PushOver";
import type { ClipBeat } from "./timeline";

/**
 * Vertical reel beat: cover-cropped 16:9 → 9:16 + one overlay family + captions.
 */
export const ClipLayer: React.FC<{ beat: ClipBeat }> = ({ beat }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  let pushAmount = 0;
  let pushSide: "left" | "right" = "left";
  for (const p of beat.pushovers ?? []) {
    const local = frame - p.from;
    if (local < 0 || local >= p.durationInFrames) continue;
    const enter = spring({
      frame: local,
      fps,
      config: panelSpring,
      durationInFrames: 28,
    });
    const exit = interpolate(
      local,
      [p.durationInFrames - 22, p.durationInFrames],
      [0, 1],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
    const amount = Math.max(0, enter - exit);
    if (amount > pushAmount) {
      pushAmount = amount;
      pushSide = p.side;
    }
  }

  // Slightly gentler push on 9:16 so face stays in frame.
  const videoShiftPct = pushAmount * 22 * (pushSide === "left" ? 1 : -1);
  const videoScale = 1 - pushAmount * 0.1;

  return (
    <AbsoluteFill style={{ background: "#0a0b0a", overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          transform: `translateX(${videoShiftPct}%) scale(${videoScale})`,
          transformOrigin: pushSide === "left" ? "right center" : "left center",
        }}
      >
        <OffthreadVideo
          src={staticFile(`clips/${beat.file}`)}
          startFrom={beat.startFrom ?? 0}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "center center",
          }}
        />
        <AbsoluteFill
          style={{
            background:
              "linear-gradient(180deg, rgba(17,19,18,0.28) 0%, transparent 22%, transparent 55%, rgba(17,19,18,0.55) 100%)",
            pointerEvents: "none",
          }}
        />
      </AbsoluteFill>

      {pushAmount > 0.02 ? (
        <AbsoluteFill
          style={{
            background:
              pushSide === "left"
                ? `linear-gradient(90deg, rgba(17,19,18,${0.62 * pushAmount}) 0%, rgba(17,19,18,${0.18 * pushAmount}) 48%, transparent 62%)`
                : `linear-gradient(270deg, rgba(17,19,18,${0.62 * pushAmount}) 0%, rgba(17,19,18,${0.18 * pushAmount}) 48%, transparent 62%)`,
            pointerEvents: "none",
          }}
        />
      ) : null}

      {beat.popups.map((popup, i) => (
        <Sequence
          key={`${beat.file}-popup-${i}`}
          from={popup.from}
          durationInFrames={popup.durationInFrames}
        >
          <GlassCard
            title={popup.title}
            subtitle={popup.subtitle}
            bullets={popup.bullets}
            variant={popup.variant}
            accentWord={popup.accentWord}
            position={popup.position}
            holdFrames={Math.max(48, popup.durationInFrames - 24)}
          />
        </Sequence>
      ))}

      {(beat.pushovers ?? []).map((p, i) => (
        <Sequence
          key={`${beat.file}-push-${i}`}
          from={p.from}
          durationInFrames={p.durationInFrames}
        >
          <PushOverPanel
            title={p.title}
            subtitle={p.subtitle}
            bullets={p.bullets}
            variant={p.variant}
            side={p.side}
          />
        </Sequence>
      ))}

      <Captions cues={beat.captions} />
    </AbsoluteFill>
  );
};
