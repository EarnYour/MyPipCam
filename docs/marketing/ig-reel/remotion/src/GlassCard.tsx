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
import {
  EASE_IN_EXPO,
  EASE_OUT_EXPO,
  glassSpring,
  snappySpring,
} from "./motion";

export type GlassVariant = "orange" | "mint";
export type GlassPosition = "top-left" | "top-right" | "center-left";

export const GlassCard: React.FC<{
  title: string;
  subtitle?: string;
  bullets?: string[];
  variant?: GlassVariant;
  accentWord?: string;
  position?: GlassPosition;
  /** Frames at full opacity before fade-out begins. */
  holdFrames?: number;
}> = ({
  title,
  subtitle,
  bullets,
  variant = "orange",
  accentWord,
  position = "top-left",
  holdFrames = 100,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({
    frame,
    fps,
    config: glassSpring,
    durationInFrames: 24,
  });

  const fadeOutStart = Math.min(
    holdFrames,
    Math.max(36, durationInFrames - 24)
  );
  const fadeOutEnd = Math.min(durationInFrames, fadeOutStart + 22);
  const opacity = interpolate(
    frame,
    [0, 12, fadeOutStart, fadeOutEnd],
    [0, 1, 1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: EASE_OUT_EXPO,
    }
  );
  const exitNudge = interpolate(frame, [fadeOutStart, fadeOutEnd], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_IN_EXPO,
  });

  const glow =
    variant === "mint"
      ? "0 0 36px rgba(125, 223, 154, 0.45)"
      : "0 0 40px rgba(255, 94, 41, 0.55)";
  const border =
    variant === "mint"
      ? "rgba(125, 223, 154, 0.45)"
      : "rgba(250, 250, 247, 0.38)";
  const accent = variant === "mint" ? brand.mint : brand.orange;

  const parts = accentWord
    ? title.split(new RegExp(`(${accentWord})`, "i"))
    : [title];

  const align =
    position === "top-right"
      ? ({ justifyContent: "flex-start", alignItems: "flex-end" } as const)
      : position === "center-left"
        ? ({ justifyContent: "center", alignItems: "flex-start" } as const)
        : ({ justifyContent: "flex-start", alignItems: "flex-start" } as const);

  return (
    <AbsoluteFill
      style={{
        ...align,
        padding: "72px 40px 40px",
        opacity,
      }}
    >
      <div
        style={{
          transform: `scale(${0.94 + enter * 0.06}) translateY(${
            (1 - enter) * 14 + exitNudge * -8
          }px)`,
          background: "rgba(250, 250, 247, 0.14)",
          border: `1px solid ${border}`,
          borderRadius: 20,
          boxShadow: `${glow}, inset 0 1px 0 rgba(255,255,255,0.25)`,
          backdropFilter: "blur(18px) saturate(1.4)",
          WebkitBackdropFilter: "blur(18px) saturate(1.4)",
          color: brand.cream,
          padding: "20px 24px",
          maxWidth: bullets?.length ? 640 : 620,
          width: "92%",
          fontFamily: fontBody,
        }}
      >
        <div
          style={{
            height: 3,
            width: 110,
            borderRadius: 2,
            background: `linear-gradient(90deg, ${accent}, transparent)`,
            boxShadow: `0 0 12px ${accent}99`,
            marginBottom: 12,
            transform: `scaleX(${enter})`,
            transformOrigin: "left center",
          }}
        />
        <div
          style={{
            fontFamily: fontDisplay,
            fontWeight: 800,
            fontSize: bullets?.length ? 32 : 38,
            letterSpacing: "-0.02em",
            lineHeight: 1.15,
            marginBottom: subtitle || bullets?.length ? 8 : 0,
          }}
        >
          {parts.map((p, i) =>
            accentWord && p.toLowerCase() === accentWord.toLowerCase() ? (
              <span
                key={i}
                style={{
                  color: brand.orange,
                  textShadow: "0 0 18px rgba(255, 94, 41, 0.65)",
                }}
              >
                {p}
              </span>
            ) : (
              <span key={i}>{p}</span>
            )
          )}
        </div>
        {subtitle ? (
          <div
            style={{
              fontSize: 20,
              opacity: 0.9,
              lineHeight: 1.35,
              marginBottom: bullets?.length ? 12 : 0,
            }}
          >
            {subtitle}
          </div>
        ) : null}
        {bullets?.length ? (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {bullets.map((bullet, i) => {
              const t = spring({
                frame: frame - 10 - i * 4,
                fps,
                config: snappySpring,
                durationInFrames: 18,
              });
              return (
                <li
                  key={bullet}
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "flex-start",
                    opacity: t,
                    transform: `translateX(${(1 - t) * 12}px)`,
                    fontSize: 18,
                    lineHeight: 1.35,
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 99,
                      marginTop: 7,
                      flexShrink: 0,
                      background: accent,
                      boxShadow: `0 0 8px ${accent}aa`,
                    }}
                  />
                  <span>{bullet}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
