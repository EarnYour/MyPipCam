import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { ClipLayer } from "./ClipLayer";
import { EndCard } from "./EndCard";
import { IntroCard } from "./IntroCard";
import { beats, secondsToFrames } from "./timeline";

/**
 * Instagram / Facebook Reel — 1080×1920.
 * Hook → install → record → library → share → Chrome Web Store end card.
 */
export const IgFbReel: React.FC = () => {
  let cursor = 0;

  return (
    <AbsoluteFill style={{ background: "#111312" }}>
      {beats.map((beat, index) => {
        const frames = secondsToFrames(beat.seconds);
        const from = cursor;
        cursor += frames;

        if (beat.kind === "intro") {
          return (
            <Sequence
              key={`intro-${index}`}
              from={from}
              durationInFrames={frames}
            >
              <IntroCard />
            </Sequence>
          );
        }

        if (beat.kind === "end") {
          return (
            <Sequence
              key={`end-${index}`}
              from={from}
              durationInFrames={frames}
            >
              <EndCard />
            </Sequence>
          );
        }

        if (beat.kind === "clip") {
          return (
            <Sequence
              key={beat.file}
              from={from}
              durationInFrames={frames}
            >
              <ClipLayer beat={beat} />
            </Sequence>
          );
        }

        return null;
      })}
    </AbsoluteFill>
  );
};
