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

/** Brand cold-open card before the hook clip. */
export const IntroCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({
    frame,
    fps,
    config: { damping: 14, stiffness: 100 },
  });
  const opacity = interpolate(
    frame,
    [0, 12, durationInFrames - 18, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(ellipse at 28% 25%, rgba(255,94,41,0.32), transparent 52%), radial-gradient(ellipse at 75% 70%, rgba(125,223,154,0.2), transparent 48%), #111312",
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
          textAlign: "center",
          padding: 48,
        }}
      >
        <div
          style={{
            fontFamily: fontDisplay,
            fontWeight: 800,
            fontSize: 72,
            letterSpacing: "-0.03em",
            marginBottom: 16,
            textShadow: "0 0 40px rgba(255,94,41,0.35)",
          }}
        >
          My
          <span
            style={{
              color: brand.orange,
              textShadow: "0 0 28px rgba(255,94,41,0.7)",
            }}
          >
            Pip
          </span>
          Cam
        </div>
        <div
          style={{
            fontSize: 32,
            opacity: 0.95,
            marginBottom: 28,
            letterSpacing: "-0.01em",
          }}
        >
          Replace{" "}
          <span
            style={{
              color: brand.orange,
              textShadow: "0 0 16px rgba(255,94,41,0.55)",
            }}
          >
            Loom
          </span>{" "}
          for free
        </div>
        <div
          style={{
            display: "inline-flex",
            gap: 12,
            alignItems: "center",
            background: "rgba(250,250,247,0.12)",
            border: "1px solid rgba(250,250,247,0.32)",
            borderRadius: 999,
            padding: "10px 22px",
            boxShadow:
              "0 0 28px rgba(125,223,154,0.25), inset 0 1px 0 rgba(255,255,255,0.2)",
            backdropFilter: "blur(14px)",
            WebkitBackdropFilter: "blur(14px)",
            fontSize: 18,
            color: brand.mint,
          }}
        >
          Free forever · No subscription
        </div>
      </div>
    </AbsoluteFill>
  );
};
