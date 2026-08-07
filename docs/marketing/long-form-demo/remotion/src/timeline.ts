import { FPS } from "./brand";
import type { GlassPosition, GlassVariant } from "./GlassCard";
import {
  POPUP_HOLD_FRAMES,
  PUSHOVER_HOLD_FRAMES,
} from "./motion";
import type { PushSide } from "./PushOver";

export type PopupSpec = {
  from: number;
  durationInFrames: number;
  title: string;
  subtitle?: string;
  bullets?: string[];
  accentWord?: string;
  variant: GlassVariant;
  position?: GlassPosition;
};

export type PushOverSpec = {
  from: number;
  durationInFrames: number;
  side: PushSide;
  title: string;
  subtitle?: string;
  bullets: string[];
  variant: GlassVariant;
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
  /** Seconds shown in the composition (trim end if shorter than file). */
  seconds: number;
  /** Skip this many composition frames into the clip (≈ seconds × FPS). */
  startFrom?: number;
  popups: PopupSpec[];
  pushovers?: PushOverSpec[];
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

const H = POPUP_HOLD_FRAMES; // ~4.2s
const P = PUSHOVER_HOLD_FRAMES; // ~5.2s

/**
 * Cut A — product-first open (skip go-live talking head + Windows build
 * digression), longer glass holds, bullet callouts, push-over splits.
 *
 * Dropped ~94s from the prior composition: intro + clips 01/02 + install
 * title + first ~32s of 06 (Windows build VO). Brand intro returns, then
 * PiP controls from mid-06.
 */
export const beats: Beat[] = [
  { kind: "intro", seconds: 3.5 },
  {
    kind: "clip",
    file: "06-install-github-pip.mp4",
    // Skip Windows-build digression (first ~32s of clip / ~0:64–1:34 of old reel)
    startFrom: 32 * FPS,
    seconds: 18,
    popups: [
      {
        from: 8,
        durationInFrames: H,
        title: "Shape · Size · Mic",
        subtitle: "Floating PiP you control",
        bullets: [
          "Circle or square",
          "Resize on the fly",
          "Pick camera & mic",
        ],
        variant: "orange",
        position: "top-right",
      },
    ],
    lowerThird: {
      from: 6,
      durationInFrames: 110,
      line1: "macOS camera bubble",
      line2: "Shape · size · always on top",
      accent: "orange",
    },
  },
  {
    kind: "title",
    seconds: 1.8,
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
        from: 12,
        durationInFrames: H,
        title: "Live camera PiP",
        subtitle: "Face + tab in one recording",
        bullets: ["Picture-in-picture overlay", "Share when ready", "Local first"],
        variant: "mint",
        position: "top-right",
      },
    ],
    pushovers: [
      {
        from: 200,
        durationInFrames: P,
        side: "left",
        title: "Recording stack",
        subtitle: "Everything you need after you hit stop",
        bullets: [
          "Tab + Cam PiP capture",
          "Library detail + playback",
          "Share link when you want it",
          "No SaaS seat required",
        ],
        variant: "orange",
      },
    ],
    lowerThird: {
      from: 8,
      durationInFrames: 110,
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
        from: 14,
        durationInFrames: H,
        title: "macOS camera bubble",
        subtitle: "Always on top for desktop & OBS",
        bullets: [
          "Drag it anywhere",
          "Shape · Size · Record…",
          "Leave Chrome? Still covered",
        ],
        variant: "orange",
        position: "top-left",
      },
      {
        from: 200,
        durationInFrames: H - 10,
        title: "Desktop path",
        subtitle: "Floating PiP while you demo apps",
        bullets: ["Always-on-top window", "Works beside OBS", "Same library folder"],
        variant: "mint",
        position: "top-left",
      },
    ],
    lowerThird: {
      from: 10,
      durationInFrames: 120,
      line1: "macOS camera bubble",
      line2: "Always-on-top for OBS / desktop",
      accent: "orange",
    },
  },
  {
    kind: "title",
    seconds: 1.8,
    eyebrow: "Library",
    title: "Your recordings, your disk",
    subtitle: "Local first · Drive optional · folders",
  },
  {
    kind: "clip",
    file: "07-library-settings-drive.mp4",
    seconds: 40,
    popups: [
      {
        from: 12,
        durationInFrames: H,
        title: "Local first · Drive optional",
        subtitle: "Connect Google only if you want",
        bullets: [
          "Files stay on your Mac",
          "Optional Drive sync",
          "Shared folder with the Mac app",
        ],
        variant: "mint",
        position: "top-right",
      },
      {
        from: 210,
        durationInFrames: H - 6,
        title: "Organize with folders",
        subtitle: "Keep demos tidy without a SaaS vault",
        bullets: ["Library folders", "Settings you control", "No subscription"],
        variant: "orange",
        position: "top-right",
      },
    ],
    lowerThird: {
      from: 8,
      durationInFrames: 110,
      line1: "Local library",
      line2: "Optional Google Drive · folders",
      accent: "mint",
    },
  },
  {
    kind: "title",
    seconds: 1.8,
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
        from: 14,
        durationInFrames: H,
        title: "Built-in editor",
        subtitle: "No another monthly bill",
        bullets: ["Cut & keep ranges", "Silence-friendly trims", "Export locally"],
        accentWord: "editor",
        variant: "orange",
        position: "top-right",
      },
    ],
    pushovers: [
      {
        from: 210,
        durationInFrames: P,
        side: "right",
        title: "Edit → export",
        subtitle: "Finish the take without uploading first",
        bullets: [
          "Timeline cut / keep",
          "Download when you’re done",
          "Files never leave your machine",
          "Replace Loom’s paid editor",
        ],
        variant: "mint",
      },
    ],
    lowerThird: {
      from: 10,
      durationInFrames: 120,
      line1: "Built-in editor",
      line2: "Trim · cut · export",
      accent: "orange",
    },
  },
  {
    kind: "title",
    seconds: 1.8,
    eyebrow: "Desktop",
    title: "Leave Chrome? Still covered",
    subtitle: "Desktop path + floating PiP",
  },
  {
    kind: "clip",
    file: "03-screen-enters.mp4",
    // Skip possible OBS hall-of-mirrors open
    startFrom: 45,
    seconds: 30,
    popups: [
      {
        from: 10,
        durationInFrames: H,
        title: "Still covered",
        subtitle: "Desktop + PiP when you leave the browser",
        bullets: [
          "Full desktop capture path",
          "macOS bubble stays on top",
          "Same free toolkit",
        ],
        variant: "mint",
        position: "top-left",
      },
    ],
    lowerThird: {
      from: 8,
      durationInFrames: 110,
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
        from: 10,
        durationInFrames: H,
        title: "Files on your Mac",
        subtitle: "No subscription. Files stay yours.",
        bullets: [
          "Library grid of your takes",
          "Drive badges when connected",
          "Free forever",
        ],
        variant: "mint",
        position: "top-right",
      },
      {
        from: 200,
        durationInFrames: H,
        title: "Install → mypipcam.earnyour.com",
        subtitle: "Chrome extension + Mac app",
        bullets: [
          "Grab GitHub Releases",
          "Add to Chrome from the Web Store",
          "Replace Loom for free",
        ],
        accentWord: "Install",
        variant: "orange",
        position: "top-right",
      },
    ],
    lowerThird: {
      from: 6,
      durationInFrames: 120,
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
