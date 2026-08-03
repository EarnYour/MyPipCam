import { FPS } from "./brand";
import type { GlassPosition, GlassVariant } from "./GlassCard";

export type PopupSpec = {
  from: number;
  durationInFrames: number;
  title: string;
  subtitle?: string;
  accentWord?: string;
  variant: GlassVariant;
  position?: GlassPosition;
};

export type LowerThirdSpec = {
  from: number;
  durationInFrames: number;
  line1: string;
  line2?: string;
  accent?: "orange" | "mint";
};

export type ClipBeat = {
  kind: "clip";
  file: string;
  /** Seconds — matches extracted clip lengths */
  seconds: number;
  popups: PopupSpec[];
  lowerThird?: LowerThirdSpec;
};

export type TitleBeat = {
  kind: "title";
  seconds: number;
  eyebrow?: string;
  title: string;
  subtitle?: string;
};

export type CardBeat = {
  kind: "intro" | "end";
  seconds: number;
};

export type Beat = ClipBeat | TitleBeat | CardBeat;

/**
 * Cut A narrative order using all extracted clips (01–09).
 * Total clip media ≈ 6m20s; cards push the highlight ~6.5–7 min.
 */
export const beats: Beat[] = [
  { kind: "intro", seconds: 4 },
  {
    kind: "clip",
    file: "01-hook-talking-head.mp4",
    seconds: 45,
    popups: [
      {
        from: 12,
        durationInFrames: 72,
        title: "Replace Loom for free",
        subtitle: "Chrome + macOS · camera PiP",
        accentWord: "Loom",
        variant: "orange",
        position: "top-left",
      },
      {
        from: 95,
        durationInFrames: 60,
        title: "Free forever",
        subtitle: "No Loom bill. No seat tax.",
        accentWord: "Free",
        variant: "mint",
        position: "top-left",
      },
    ],
    lowerThird: {
      from: 8,
      durationInFrames: 90,
      line1: "MyPipCam",
      line2: "Free Loom-style recorder",
      accent: "orange",
    },
  },
  {
    kind: "clip",
    file: "02-problem-talking-head.mp4",
    seconds: 40,
    popups: [
      {
        from: 18,
        durationInFrames: 70,
        title: "No Loom bill",
        subtitle: "Local-first. Free forever.",
        accentWord: "Loom",
        variant: "mint",
      },
      {
        from: 75,
        durationInFrames: 55,
        title: "No seat tax",
        subtitle: "Keep files on your Mac",
        variant: "orange",
      },
    ],
    lowerThird: {
      from: 10,
      durationInFrames: 85,
      line1: "Why I built this",
      line2: "Free forever · No subscription",
      accent: "mint",
    },
  },
  {
    kind: "title",
    seconds: 1.6,
    eyebrow: "Step 1",
    title: "Install in under a minute",
    subtitle: "GitHub Releases → Load unpacked",
  },
  {
    kind: "clip",
    file: "06-install-github-pip.mp4",
    seconds: 50,
    popups: [
      {
        from: 14,
        durationInFrames: 70,
        title: "Free · Open source",
        subtitle: "Download zip → Load unpacked",
        accentWord: "Free",
        variant: "orange",
        position: "top-right",
      },
      {
        from: 95,
        durationInFrames: 65,
        title: "Pin it",
        subtitle: "Then record any https tab",
        variant: "mint",
        position: "top-right",
      },
    ],
    lowerThird: {
      from: 12,
      durationInFrames: 90,
      line1: "Chrome extension",
      line2: "Install free from GitHub",
      accent: "orange",
    },
  },
  {
    kind: "title",
    seconds: 1.5,
    eyebrow: "Record",
    title: "Tab + Cam PiP",
    subtitle: "Record this Chrome tab with your face",
  },
  {
    kind: "clip",
    file: "04-library-detail.mp4",
    seconds: 45,
    popups: [
      {
        from: 14,
        durationInFrames: 70,
        title: "Live camera PiP",
        subtitle: "Tab + Cam in one take",
        variant: "mint",
        position: "top-right",
      },
      {
        from: 90,
        durationInFrames: 60,
        title: "Share when ready",
        subtitle: "Local first — Drive optional",
        variant: "orange",
        position: "top-right",
      },
    ],
    lowerThird: {
      from: 10,
      durationInFrames: 85,
      line1: "Record this tab",
      line2: "Chrome extension · Tab + camera PiP",
      accent: "mint",
    },
  },
  {
    kind: "clip",
    file: "05-macos-pip-menu.mp4",
    seconds: 40,
    popups: [
      {
        from: 16,
        durationInFrames: 70,
        title: "Drag it anywhere",
        subtitle: "Shape · Size · Always on top",
        variant: "orange",
        position: "top-left",
      },
    ],
    lowerThird: {
      from: 12,
      durationInFrames: 90,
      line1: "macOS camera bubble",
      line2: "Always-on-top for OBS / desktop",
      accent: "orange",
    },
  },
  {
    kind: "title",
    seconds: 1.5,
    eyebrow: "Library",
    title: "Your recordings, your disk",
    subtitle: "Local first · Drive optional",
  },
  {
    kind: "clip",
    file: "07-library-settings-drive.mp4",
    seconds: 40,
    popups: [
      {
        from: 16,
        durationInFrames: 70,
        title: "Local first · Drive optional",
        subtitle: "Connect Google only if you want",
        variant: "mint",
        position: "top-right",
      },
    ],
    lowerThird: {
      from: 10,
      durationInFrames: 85,
      line1: "Local library",
      line2: "Optional Google Drive",
      accent: "mint",
    },
  },
  {
    kind: "title",
    seconds: 1.5,
    eyebrow: "Editor",
    title: "Trim without SaaS",
    subtitle: "Cut · silence · export locally",
  },
  {
    kind: "clip",
    file: "08-editor-export.mp4",
    seconds: 45,
    popups: [
      {
        from: 18,
        durationInFrames: 70,
        title: "Export locally",
        subtitle: "Cut · silence · download",
        accentWord: "Export",
        variant: "orange",
        position: "top-right",
      },
    ],
    lowerThird: {
      from: 12,
      durationInFrames: 90,
      line1: "Built-in editor",
      line2: "Trim · cut · export",
      accent: "orange",
    },
  },
  {
    kind: "title",
    seconds: 1.5,
    eyebrow: "Desktop",
    title: "Leave Chrome? Still covered",
    subtitle: "Desktop path + floating PiP",
  },
  {
    kind: "clip",
    file: "03-screen-enters.mp4",
    seconds: 35,
    popups: [
      {
        from: 14,
        durationInFrames: 70,
        title: "Still covered",
        subtitle: "Desktop + PiP when you leave Chrome",
        variant: "mint",
        position: "top-left",
      },
    ],
    lowerThird: {
      from: 10,
      durationInFrames: 85,
      line1: "Desktop + PiP",
      line2: "macOS app for the whole screen",
      accent: "mint",
    },
  },
  {
    kind: "clip",
    file: "09-library-grid-cta.mp4",
    seconds: 40,
    popups: [
      {
        from: 14,
        durationInFrames: 65,
        title: "Files on your Mac",
        subtitle: "No subscription. Files stay yours.",
        variant: "mint",
        position: "top-right",
      },
      {
        from: 85,
        durationInFrames: 70,
        title: "Install → mypipcam.earnyour.com",
        subtitle: "Free forever",
        accentWord: "Install",
        variant: "orange",
        position: "top-right",
      },
    ],
    lowerThird: {
      from: 8,
      durationInFrames: 90,
      line1: "Install free",
      line2: "mypipcam.earnyour.com",
      accent: "orange",
    },
  },
  { kind: "end", seconds: 10 },
];

export function secondsToFrames(seconds: number): number {
  return Math.round(seconds * FPS);
}

export function totalDurationInFrames(list: Beat[] = beats): number {
  return list.reduce((sum, b) => sum + secondsToFrames(b.seconds), 0);
}

export const HIGHLIGHT_DURATION_FRAMES = totalDurationInFrames();
