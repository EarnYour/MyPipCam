import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
} from "remotion";

export const EndCard: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(ellipse at 30% 20%, rgba(255,94,41,0.28), transparent 50%), radial-gradient(ellipse at 70% 80%, rgba(125,223,154,0.22), transparent 45%), #111312",
        justifyContent: "center",
        alignItems: "center",
        opacity,
        fontFamily: "Figtree, system-ui, sans-serif",
        color: "#fafaf7",
      }}
    >
      <div
        style={{
          background: "rgba(250, 250, 247, 0.12)",
          border: "1px solid rgba(250, 250, 247, 0.35)",
          borderRadius: 24,
          boxShadow:
            "0 0 48px rgba(255, 94, 41, 0.4), inset 0 1px 0 rgba(255,255,255,0.25)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          padding: "48px 64px",
          textAlign: "center",
          maxWidth: 860,
        }}
      >
        <div
          style={{
            fontFamily: "Syne, system-ui, sans-serif",
            fontWeight: 800,
            fontSize: 56,
            letterSpacing: "-0.02em",
            marginBottom: 12,
          }}
        >
          Install{" "}
          <span
            style={{
              color: "#ff5e29",
              textShadow: "0 0 20px rgba(255,94,41,0.6)",
            }}
          >
            MyPipCam
          </span>
        </div>
        <div style={{ fontSize: 26, opacity: 0.92, marginBottom: 28 }}>
          Replace Loom for free — Chrome extension + Mac bubble
        </div>
        <div
          style={{
            fontSize: 28,
            color: "#7ddf9a",
            textShadow: "0 0 16px rgba(125,223,154,0.4)",
            lineHeight: 1.5,
          }}
        >
          mypipcam.earnyour.com
          <br />
          github.com/EarnYour/MyPipCam/releases
        </div>
      </div>
    </AbsoluteFill>
  );
};
