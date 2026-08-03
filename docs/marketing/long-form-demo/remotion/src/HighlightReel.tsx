import React from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  staticFile,
} from "remotion";
import { BeatTitle } from "./BeatTitle";
import { EndCard } from "./EndCard";
import { GlassCard } from "./GlassCard";
import { IntroCard } from "./IntroCard";
import { LowerThird } from "./LowerThird";
import { beats, secondsToFrames } from "./timeline";

/**
 * Cut A highlight: brand intro → clips 01–09 (narrative order) → end card.
 * Glass popups + lower-thirds per EDIT_PLAN / OVERLAY_DESIGN.
 */
export const HighlightReel: React.FC = () => {
  let cursor = 0;

  return (
    <AbsoluteFill style={{ background: "#111312" }}>
      {beats.map((beat, index) => {
        const frames = secondsToFrames(beat.seconds);
        const from = cursor;
        cursor += frames;

        if (beat.kind === "intro") {
          return (
            <Sequence key={`intro-${index}`} from={from} durationInFrames={frames}>
              <IntroCard />
            </Sequence>
          );
        }

        if (beat.kind === "end") {
          return (
            <Sequence key={`end-${index}`} from={from} durationInFrames={frames}>
              <EndCard />
            </Sequence>
          );
        }

        if (beat.kind === "title") {
          return (
            <Sequence key={`title-${index}`} from={from} durationInFrames={frames}>
              <BeatTitle
                eyebrow={beat.eyebrow}
                title={beat.title}
                subtitle={beat.subtitle}
              />
            </Sequence>
          );
        }

        return (
          <Sequence key={beat.file} from={from} durationInFrames={frames}>
            <AbsoluteFill>
              <OffthreadVideo
                src={staticFile(`clips/${beat.file}`)}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
              {/* Soft vignette */}
              <AbsoluteFill
                style={{
                  background:
                    "radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.18) 100%)",
                  pointerEvents: "none",
                }}
              />
              {beat.lowerThird ? (
                <Sequence
                  from={beat.lowerThird.from}
                  durationInFrames={beat.lowerThird.durationInFrames}
                >
                  <LowerThird
                    line1={beat.lowerThird.line1}
                    line2={beat.lowerThird.line2}
                    accent={beat.lowerThird.accent}
                  />
                </Sequence>
              ) : null}
              {beat.popups.map((popup, i) => (
                <Sequence
                  key={`${beat.file}-popup-${i}`}
                  from={popup.from}
                  durationInFrames={popup.durationInFrames}
                >
                  <GlassCard
                    title={popup.title}
                    subtitle={popup.subtitle}
                    variant={popup.variant}
                    accentWord={popup.accentWord}
                    position={popup.position}
                    holdFrames={Math.max(24, popup.durationInFrames - 18)}
                  />
                </Sequence>
              ))}
            </AbsoluteFill>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
