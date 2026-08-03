import React from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  staticFile,
} from "remotion";
import { GlassCard } from "./GlassCard";
import { EndCard } from "./EndCard";

/**
 * Practical scaffold: stitches extracted clips + timed glass popups.
 * Clips live in ../clips — copied/symlinked into public/ at install time
 * (see README). Durations are approximate @ 30fps.
 */
const clips = [
  {
    file: "01-hook-talking-head.mp4",
    frames: 45 * 30,
    popup: {
      from: 10,
      title: "Replace Loom for free",
      subtitle: "Chrome + macOS · camera PiP",
      accentWord: "Loom",
      variant: "orange" as const,
    },
  },
  {
    file: "02-problem-talking-head.mp4",
    frames: 40 * 30,
    popup: {
      from: 20,
      title: "No Loom bill",
      subtitle: "Local-first. Free forever.",
      accentWord: "Loom",
      variant: "mint" as const,
    },
  },
  {
    file: "06-install-github-pip.mp4",
    frames: 50 * 30,
    popup: {
      from: 15,
      title: "Install free",
      subtitle: "GitHub Releases → Load unpacked",
      variant: "orange" as const,
    },
  },
  {
    file: "04-library-detail.mp4",
    frames: 45 * 30,
    popup: {
      from: 12,
      title: "Tab + Cam PiP",
      subtitle: "Record this Chrome tab",
      variant: "mint" as const,
    },
  },
  {
    file: "05-macos-pip-menu.mp4",
    frames: 40 * 30,
    popup: {
      from: 18,
      title: "macOS bubble",
      subtitle: "Always on top · drag anywhere",
      variant: "orange" as const,
    },
  },
  {
    file: "08-editor-export.mp4",
    frames: 45 * 30,
    popup: {
      from: 20,
      title: "Trim without SaaS",
      subtitle: "Cut · export locally",
      variant: "mint" as const,
    },
  },
  {
    file: "09-library-grid-cta.mp4",
    frames: 40 * 30,
    popup: {
      from: 15,
      title: "Your library",
      subtitle: "Local folder · Drive optional",
      variant: "orange" as const,
    },
  },
];

export const HighlightReel: React.FC = () => {
  let cursor = 0;
  const endFrames = 8 * 30;

  return (
    <AbsoluteFill style={{ background: "#111312" }}>
      {clips.map((c) => {
        const from = cursor;
        cursor += c.frames;
        return (
          <Sequence key={c.file} from={from} durationInFrames={c.frames}>
            <AbsoluteFill>
              <OffthreadVideo
                src={staticFile(c.file)}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
              <Sequence from={c.popup.from} durationInFrames={75}>
                <GlassCard
                  title={c.popup.title}
                  subtitle={c.popup.subtitle}
                  variant={c.popup.variant}
                  accentWord={c.popup.accentWord}
                />
              </Sequence>
            </AbsoluteFill>
          </Sequence>
        );
      })}
      <Sequence from={cursor} durationInFrames={endFrames}>
        <EndCard />
      </Sequence>
    </AbsoluteFill>
  );
};
