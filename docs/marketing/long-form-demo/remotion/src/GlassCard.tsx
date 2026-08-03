import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

const colors = {
  orange: "#ff5e29",
  mint: "#7ddf9a",
  cream: "#fafaf7",
};

export type GlassVariant = "orange" | "mint";

export const GlassCard: React.FC<{
  title: string;
  subtitle?: string;
  variant?: GlassVariant;
  accentWord?: string;
}> = ({ title, subtitle, variant = "orange", accentWord }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({
    frame,
    fps,
    config: { damping: 14, stiffness: 120 },
  });
  const opacity = interpolate(frame, [0, 8, 70, 90], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const glow =
    variant === "mint"
      ? "0 0 36px rgba(125, 223, 154, 0.45)"
      : "0 0 40px rgba(255, 94, 41, 0.55)";
  const border =
    variant === "mint"
      ? "rgba(125, 223, 154, 0.45)"
      : "rgba(250, 250, 247, 0.38)";

  const parts = accentWord
    ? title.split(new RegExp(`(${accentWord})`, "i"))
    : [title];

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-start",
        alignItems: "flex-start",
        padding: 64,
        opacity,
      }}
    >
      <div
        style={{
          transform: `scale(${0.92 + enter * 0.08}) translateY(${
            (1 - enter) * 12
          }px)`,
          background: "rgba(250, 250, 247, 0.14)",
          border: `1px solid ${border}`,
          borderRadius: 20,
          boxShadow: `${glow}, inset 0 1px 0 rgba(255,255,255,0.25)`,
          backdropFilter: "blur(18px) saturate(1.4)",
          WebkitBackdropFilter: "blur(18px) saturate(1.4)",
          color: colors.cream,
          padding: "20px 28px",
          maxWidth: 520,
          fontFamily: "Figtree, system-ui, sans-serif",
        }}
      >
        <div
          style={{
            fontFamily: "Syne, system-ui, sans-serif",
            fontWeight: 800,
            fontSize: 42,
            letterSpacing: "-0.02em",
            lineHeight: 1.15,
            marginBottom: subtitle ? 8 : 0,
          }}
        >
          {parts.map((p, i) =>
            accentWord && p.toLowerCase() === accentWord.toLowerCase() ? (
              <span
                key={i}
                style={{
                  color: colors.orange,
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
          <div style={{ fontSize: 22, opacity: 0.9 }}>{subtitle}</div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
