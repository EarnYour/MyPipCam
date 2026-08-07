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

/** Vertical CTA — Chrome Web Store primary, GitHub/macOS secondary. */
export const EndCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({
    frame,
    fps,
    config: { damping: 16, stiffness: 90 },
  });
  const opacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(ellipse at 30% 20%, rgba(255,94,41,0.3), transparent 50%), radial-gradient(ellipse at 70% 80%, rgba(125,223,154,0.24), transparent 45%), #111312",
        justifyContent: "center",
        alignItems: "center",
        opacity,
        fontFamily: fontBody,
        color: brand.cream,
        padding: 40,
      }}
    >
      <div
        style={{
          transform: `scale(${0.94 + enter * 0.06})`,
          background: "rgba(250, 250, 247, 0.12)",
          border: "1px solid rgba(250, 250, 247, 0.35)",
          borderRadius: 28,
          boxShadow:
            "0 0 48px rgba(255, 94, 41, 0.4), inset 0 1px 0 rgba(255,255,255,0.25)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          padding: "48px 36px",
          textAlign: "center",
          maxWidth: 920,
          width: "100%",
        }}
      >
        <div
          style={{
            fontFamily: fontDisplay,
            fontWeight: 800,
            fontSize: 52,
            letterSpacing: "-0.02em",
            marginBottom: 14,
            lineHeight: 1.15,
          }}
        >
          Add{" "}
          <span
            style={{
              color: brand.orange,
              textShadow: "0 0 20px rgba(255,94,41,0.6)",
            }}
          >
            MyPipCam
          </span>{" "}
          to Chrome
        </div>
        <div style={{ fontSize: 24, opacity: 0.92, marginBottom: 28 }}>
          Replace Loom for free
        </div>
        <div
          style={{
            fontSize: 22,
            color: brand.mint,
            textShadow: "0 0 16px rgba(125,223,154,0.4)",
            lineHeight: 1.5,
            fontWeight: 600,
            marginBottom: 18,
            wordBreak: "break-all",
          }}
        >
          {brand.store}
        </div>
        <div
          style={{
            fontSize: 18,
            opacity: 0.88,
            lineHeight: 1.55,
            marginBottom: 22,
          }}
        >
          {brand.site}
          <br />
          <span style={{ opacity: 0.8 }}>{brand.github}</span>
          <br />
          <span style={{ fontSize: 16, opacity: 0.7 }}>
            Open source · optional macOS app
          </span>
        </div>
        <div style={{ fontSize: 18, opacity: 0.75 }}>
          Free forever · Link in bio
        </div>
      </div>
    </AbsoluteFill>
  );
};
