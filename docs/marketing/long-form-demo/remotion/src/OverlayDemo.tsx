import React from "react";
import { AbsoluteFill } from "remotion";
import { GlassCard, GlassVariant } from "./GlassCard";

export const OverlayDemo: React.FC<{
  title: string;
  subtitle: string;
  variant: GlassVariant;
}> = ({ title, subtitle, variant }) => {
  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(ellipse at 25% 30%, rgba(255,94,41,0.3), transparent 50%), #0a0c0b",
      }}
    >
      <GlassCard
        title={title}
        subtitle={subtitle}
        variant={variant}
        accentWord="Loom"
      />
    </AbsoluteFill>
  );
};
