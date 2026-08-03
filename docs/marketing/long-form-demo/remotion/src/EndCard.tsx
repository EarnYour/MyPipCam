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

export const EndCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({
    frame,
    fps,
    config: { damping: 16, stiffness: 90 },
  });
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
        fontFamily: fontBody,
        color: brand.cream,
      }}
    >
      <div
        style={{
          transform: `scale(${0.94 + enter * 0.06})`,
          background: "rgba(250, 250, 247, 0.12)",
          border: "1px solid rgba(250, 250, 247, 0.35)",
          borderRadius: 24,
          boxShadow:
            "0 0 48px rgba(255, 94, 41, 0.4), inset 0 1px 0 rgba(255,255,255,0.25)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          padding: "48px 64px",
          textAlign: "center",
          maxWidth: 920,
        }}
      >
        <div
          style={{
            fontFamily: fontDisplay,
            fontWeight: 800,
            fontSize: 56,
            letterSpacing: "-0.02em",
            marginBottom: 12,
          }}
        >
          Install{" "}
          <span
            style={{
              color: brand.orange,
              textShadow: "0 0 20px rgba(255,94,41,0.6)",
            }}
          >
            MyPipCam
          </span>
        </div>
        <div style={{ fontSize: 26, opacity: 0.92, marginBottom: 32 }}>
          Replace Loom for free — Chrome extension + Mac bubble
        </div>
        <div
          style={{
            fontSize: 30,
            color: brand.mint,
            textShadow: "0 0 16px rgba(125,223,154,0.4)",
            lineHeight: 1.55,
            fontWeight: 600,
            marginBottom: 20,
          }}
        >
          {brand.siteUrl}
          <br />
          <span style={{ fontSize: 24, opacity: 0.95 }}>
            {brand.releasesUrl}
          </span>
        </div>
        <div
          style={{
            marginTop: 8,
            fontSize: 18,
            opacity: 0.75,
          }}
        >
          Free forever · Link in description
        </div>
      </div>
    </AbsoluteFill>
  );
};
