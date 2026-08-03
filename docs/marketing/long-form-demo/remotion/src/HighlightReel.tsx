import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { BeatTitle } from "./BeatTitle";
import { ClipLayer } from "./ClipLayer";
import { EndCard } from "./EndCard";
import { IntroCard } from "./IntroCard";
import { beats, secondsToFrames } from "./timeline";

/**
 * Cut A highlight: brand intro → clips (speech-first) → end card.
 * Glass popups, bullet callouts, and push-over splits per EDIT_PLAN.
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

        if (beat.kind === "clip") {
          return (
            <Sequence key={beat.file} from={from} durationInFrames={frames}>
              <ClipLayer beat={beat} />
            </Sequence>
          );
        }

        return null;
      })}
    </AbsoluteFill>
  );
};
