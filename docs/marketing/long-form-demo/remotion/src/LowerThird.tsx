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

export const LowerThird: React.FC<{
  line1: string;
  line2?: string;
  accent?: "orange" | "mint";
}> = ({ line1, line2, accent = "orange" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({
    frame,
    fps,
    config: { damping: 16, stiffness: 140 },
  });
  const opacity = interpolate(frame, [0, 10, 70, 90], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const bar =
    accent === "mint"
      ? `linear-gradient(90deg, ${brand.mint}, transparent)`
      : `linear-gradient(90deg, ${brand.orange}, transparent)`;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "flex-start",
        padding: "0 0 72px 64px",
        opacity,
      }}
    >
      <div
        style={{
          transform: `translateX(${(1 - enter) * -28}px)`,
          background: "rgba(17, 19, 18, 0.55)",
          border: "1px solid rgba(250, 250, 247, 0.28)",
          borderRadius: 16,
          boxShadow:
            "0 0 28px rgba(255, 94, 41, 0.22), inset 0 1px 0 rgba(255,255,255,0.18)",
          backdropFilter: "blur(16px) saturate(1.3)",
          WebkitBackdropFilter: "blur(16px) saturate(1.3)",
          color: brand.cream,
          padding: "14px 22px 14px 18px",
          minWidth: 320,
          fontFamily: fontBody,
        }}
      >
        <div
          style={{
            height: 3,
            width: 120,
            borderRadius: 2,
            background: bar,
            marginBottom: 10,
            boxShadow:
              accent === "mint"
                ? "0 0 12px rgba(125,223,154,0.55)"
                : "0 0 12px rgba(255,94,41,0.55)",
          }}
        />
        <div
          style={{
            fontFamily: fontDisplay,
            fontWeight: 800,
            fontSize: 26,
            letterSpacing: "-0.02em",
            lineHeight: 1.2,
          }}
        >
          {line1}
        </div>
        {line2 ? (
          <div style={{ fontSize: 18, opacity: 0.88, marginTop: 4 }}>
            {line2}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
