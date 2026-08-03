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
import { GlassCard } from "./GlassCard";
import { LowerThird } from "./LowerThird";
import { panelSpring } from "./motion";
import { PushOverPanel } from "./PushOver";
import type { ClipBeat } from "./timeline";

/**
 * One highlight beat: source clip + glass popups + optional push-over
 * split (video slides aside for a full-panel bullet callout).
 */
export const ClipLayer: React.FC<{ beat: ClipBeat }> = ({ beat }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Strongest active push-over drives the video slide.
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

  // Panel on left → video slides right; panel on right → video slides left.
  const videoShiftPct = pushAmount * 28 * (pushSide === "left" ? 1 : -1);
  const videoScale = 1 - pushAmount * 0.12;

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
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
        <AbsoluteFill
          style={{
            background:
              "radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.2) 100%)",
            pointerEvents: "none",
          }}
        />
      </AbsoluteFill>

      {/* Dim plate behind push-over panel for readability */}
      {pushAmount > 0.02 ? (
        <AbsoluteFill
          style={{
            background:
              pushSide === "left"
                ? `linear-gradient(90deg, rgba(17,19,18,${0.55 * pushAmount}) 0%, rgba(17,19,18,${0.15 * pushAmount}) 42%, transparent 58%)`
                : `linear-gradient(270deg, rgba(17,19,18,${0.55 * pushAmount}) 0%, rgba(17,19,18,${0.15 * pushAmount}) 42%, transparent 58%)`,
            pointerEvents: "none",
          }}
        />
      ) : null}

      {beat.lowerThird ? (
        <Sequence
          from={beat.lowerThird.from}
          durationInFrames={beat.lowerThird.durationInFrames}
        >
          <LowerThird
            line1={beat.lowerThird.line1}
            line2={beat.lowerThird.line2}
            accent={beat.lowerThird.accent}
          />
        </Sequence>
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
    </AbsoluteFill>
  );
};
