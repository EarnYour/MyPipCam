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
import type { GlassVariant } from "./GlassCard";
import {
  EASE_IN_EXPO,
  EASE_OUT_EXPO,
  panelSpring,
  snappySpring,
} from "./motion";

export type PushSide = "left" | "right";

/**
 * Full-height glass callout panel (Chronixel “clean glass panels” +
 * Night Drive HUD readouts). Used in split / push-over layouts.
 */
export const PushOverPanel: React.FC<{
  title: string;
  subtitle?: string;
  bullets: string[];
  variant?: GlassVariant;
  /** Which side the panel occupies. */
  side?: PushSide;
}> = ({
  title,
  subtitle,
  bullets,
  variant = "orange",
  side = "left",
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const enter = spring({
    frame,
    fps,
    config: panelSpring,
    durationInFrames: 28,
  });
  const fadeOut = interpolate(
    frame,
    [durationInFrames - 22, durationInFrames],
    [0, 1],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: EASE_IN_EXPO,
    }
  );
  const visibility = Math.max(0, enter - fadeOut);
  const slideX = interpolate(
    visibility,
    [0, 1],
    [side === "left" ? -48 : 48, 0],
    { easing: EASE_OUT_EXPO }
  );

  const glow =
    variant === "mint"
      ? "0 0 48px rgba(125, 223, 154, 0.4)"
      : "0 0 48px rgba(255, 94, 41, 0.45)";
  const accent = variant === "mint" ? brand.mint : brand.orange;
  const barProgress = spring({
    frame: frame - 6,
    fps,
    config: snappySpring,
    durationInFrames: 22,
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: side === "left" ? "flex-start" : "flex-end",
        padding: "120px 28px 280px",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          width: "52%",
          maxWidth: 520,
          minWidth: 300,
          opacity: visibility,
          transform: `translateX(${slideX}px)`,
          background:
            "linear-gradient(160deg, rgba(250,250,247,0.16) 0%, rgba(17,19,18,0.55) 100%)",
          border: `1px solid ${
            variant === "mint"
              ? "rgba(125, 223, 154, 0.45)"
              : "rgba(250, 250, 247, 0.38)"
          }`,
          borderRadius: 22,
          boxShadow: `${glow}, inset 0 1px 0 rgba(255,255,255,0.22)`,
          backdropFilter: "blur(20px) saturate(1.45)",
          WebkitBackdropFilter: "blur(20px) saturate(1.45)",
          color: brand.cream,
          padding: "28px 32px 30px",
          fontFamily: fontBody,
        }}
      >
        <div
          style={{
            height: 3,
            width: `${barProgress * 100}%`,
            maxWidth: 160,
            borderRadius: 2,
            background: `linear-gradient(90deg, ${accent}, transparent)`,
            boxShadow: `0 0 14px ${accent}99`,
            marginBottom: 16,
          }}
        />
        <div
          style={{
            fontFamily: fontDisplay,
            fontWeight: 800,
            fontSize: 30,
            letterSpacing: "-0.02em",
            lineHeight: 1.15,
            marginBottom: subtitle ? 8 : 16,
          }}
        >
          {title}
        </div>
        {subtitle ? (
          <div
            style={{
              fontSize: 16,
              opacity: 0.88,
              marginBottom: 16,
              lineHeight: 1.35,
            }}
          >
            {subtitle}
          </div>
        ) : null}
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {bullets.map((bullet, i) => {
            const t = spring({
              frame: frame - 14 - i * 5,
              fps,
              config: snappySpring,
              durationInFrames: 20,
            });
            const itemVis = Math.max(0, t - fadeOut);
            return (
              <li
                key={bullet}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  opacity: itemVis,
                  transform: `translateX(${(1 - itemVis) * 16}px)`,
                  fontSize: 17,
                  lineHeight: 1.35,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 99,
                    marginTop: 8,
                    flexShrink: 0,
                    background: accent,
                    boxShadow: `0 0 10px ${accent}aa`,
                  }}
                />
                <span>{bullet}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </AbsoluteFill>
  );
};
