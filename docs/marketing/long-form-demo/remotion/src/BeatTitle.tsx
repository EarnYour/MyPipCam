import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { brand } from "./brand";
import { fontBody, fontDisplay } from "./fonts";

/** Short interstitial title between Cut A beats. */
export const BeatTitle: React.FC<{
  eyebrow?: string;
  title: string;
  subtitle?: string;
}> = ({ eyebrow, title, subtitle }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({
    frame,
    fps,
    config: { damping: 15, stiffness: 130 },
  });
  const opacity = interpolate(
    frame,
    [0, 8, durationInFrames - 12, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(ellipse at 40% 40%, rgba(255,94,41,0.18), transparent 55%), #111312",
        justifyContent: "center",
        alignItems: "center",
        opacity,
        fontFamily: fontBody,
        color: brand.cream,
      }}
    >
      <div
        style={{
          transform: `translateY(${(1 - enter) * 16}px)`,
          textAlign: "center",
          maxWidth: 900,
          padding: 40,
        }}
      >
        {eyebrow ? (
          <div
            style={{
              fontSize: 18,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: brand.mint,
              marginBottom: 14,
              textShadow: "0 0 14px rgba(125,223,154,0.4)",
            }}
          >
            {eyebrow}
          </div>
        ) : null}
        <div
          style={{
            fontFamily: fontDisplay,
            fontWeight: 800,
            fontSize: 52,
            letterSpacing: "-0.02em",
            lineHeight: 1.15,
            marginBottom: subtitle ? 12 : 0,
          }}
        >
          {title}
        </div>
        {subtitle ? (
          <div style={{ fontSize: 24, opacity: 0.88 }}>{subtitle}</div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
