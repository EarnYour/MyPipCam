import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { brand } from "./brand";
import { fontDisplay } from "./fonts";
import { EASE_OUT_EXPO, snappySpring } from "./motion";

export type CaptionCue = {
  /** Local frame within the parent Sequence. */
  from: number;
  durationInFrames: number;
  text: string;
};

/**
 * IG/FB-style phrase captions — bottom safe area, high contrast, spring in.
 */
export const Captions: React.FC<{ cues: CaptionCue[] }> = ({ cues }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const active = cues.find(
    (c) => frame >= c.from && frame < c.from + c.durationInFrames
  );
  if (!active) return null;

  const local = frame - active.from;
  const enter = spring({
    frame: local,
    fps,
    config: snappySpring,
    durationInFrames: 14,
  });
  const fadeOut = interpolate(
    local,
    [active.durationInFrames - 8, active.durationInFrames],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const opacity = Math.max(0, enter - fadeOut);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: 220,
        paddingLeft: 36,
        paddingRight: 36,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          opacity,
          transform: `translateY(${(1 - enter) * 18}px) scale(${
            0.96 + enter * 0.04
          })`,
          background: "rgba(17, 19, 18, 0.72)",
          border: "1px solid rgba(250, 250, 247, 0.28)",
          borderRadius: 16,
          boxShadow:
            "0 8px 32px rgba(0,0,0,0.45), 0 0 24px rgba(255,94,41,0.18)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          padding: "14px 22px",
          maxWidth: 920,
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontFamily: fontDisplay,
            fontWeight: 800,
            fontSize: 40,
            letterSpacing: "-0.02em",
            lineHeight: 1.2,
            color: brand.cream,
            textShadow: "0 2px 12px rgba(0,0,0,0.55)",
          }}
        >
          {active.text.split(" ").map((word, i) => {
            const highlight =
              /loom|free|chrome|drive|library|share|pin/i.test(word);
            return (
              <span
                key={`${active.from}-${i}`}
                style={{
                  color: highlight ? brand.orange : brand.cream,
                  marginRight: i < active.text.split(" ").length - 1 ? 10 : 0,
                  textShadow: highlight
                    ? "0 0 18px rgba(255,94,41,0.55)"
                    : undefined,
                }}
              >
                {word}
              </span>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** Single cue wrapper used inside Sequence (optional). */
export const CaptionLine: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({
    frame,
    fps,
    config: snappySpring,
    durationInFrames: 14,
  });
  const opacity = interpolate(
    frame,
    [0, 8, durationInFrames - 8, durationInFrames],
    [0, 1, 1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: EASE_OUT_EXPO,
    }
  );

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: 220,
        opacity,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          transform: `translateY(${(1 - enter) * 14}px)`,
          fontFamily: fontDisplay,
          fontWeight: 800,
          fontSize: 40,
          color: brand.cream,
          background: "rgba(17,19,18,0.72)",
          padding: "14px 22px",
          borderRadius: 16,
          border: "1px solid rgba(250,250,247,0.28)",
          maxWidth: 920,
          textAlign: "center",
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};
