import { FPS } from "./brand";
import type { CaptionCue } from "./Captions";
import type { GlassPosition, GlassVariant } from "./GlassCard";
import { POPUP_HOLD_FRAMES, PUSHOVER_HOLD_FRAMES } from "./motion";
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

export type ClipBeat = {
  kind: "clip";
  file: string;
  seconds: number;
  /** Skip into source clip (composition frames @ 30fps). */
  startFrom?: number;
  popups: PopupSpec[];
  pushovers?: PushOverSpec[];
  captions: CaptionCue[];
};

export type CardBeat = {
  kind: "intro" | "end";
  seconds: number;
};

export type Beat = ClipBeat | CardBeat;

const H = Math.round(POPUP_HOLD_FRAMES * 0.85); // ~3.5s — tighter for reels
const P = Math.round(PUSHOVER_HOLD_FRAMES * 0.8); // ~4.2s

/**
 * IG/FB reel — hard cuts from 2026-08-07 talking-head publish demo.
 * Source timestamps documented in ../BEAT_SHEET.md
 */
export const beats: Beat[] = [
  { kind: "intro", seconds: 2 },
  {
    kind: "clip",
    file: "01-hook.mp4",
    // Source 0:07.40–0:19.40 (clip starts at 0:07.40)
    seconds: 12,
    popups: [
      {
        from: 18,
        durationInFrames: H,
        title: "Replace Loom for free",
        subtitle: "Live on the Chrome Web Store",
        bullets: [
          "Published Chrome extension",
          "Everything Loom does",
          "No subscription",
        ],
        accentWord: "free",
        variant: "orange",
        position: "top-left",
      },
    ],
    captions: [
      { from: 0, durationInFrames: 48, text: "I'm excited." },
      {
        from: 48,
        durationInFrames: 90,
        text: "Chrome extension — live for free",
      },
      {
        from: 138,
        durationInFrames: 100,
        text: "Replaces Loom — absolutely free",
      },
      {
        from: 238,
        durationInFrames: 122,
        text: "No subscription tied on",
      },
    ],
  },
  {
    kind: "clip",
    file: "02-install.mp4",
    // Clip starts source 1:14.92; skip 10s → source 1:24.92 (open in Chrome)
    startFrom: 10 * FPS,
    seconds: 11,
    popups: [],
    pushovers: [
      {
        from: 24,
        durationInFrames: P,
        side: "left",
        title: "Add to Chrome",
        subtitle: "Install in under a minute",
        bullets: [
          "Open the Web Store link",
          "Works on any OS with Chrome",
          "One click — Add to Chrome",
        ],
        variant: "mint",
      },
    ],
    captions: [
      {
        from: 0,
        durationInFrames: 70,
        text: "Open the link in Chrome",
      },
      {
        from: 70,
        durationInFrames: 90,
        text: "Any OS — as long as you use Chrome",
      },
      {
        from: 160,
        durationInFrames: 80,
        text: "Add to Chrome",
      },
      {
        from: 240,
        durationInFrames: 90,
        text: "Install the free extension",
      },
    ],
  },
  {
    kind: "clip",
    file: "03-record.mp4",
    // Source 1:58.84–2:08.84
    seconds: 10,
    popups: [
      {
        from: 12,
        durationInFrames: H - 20,
        title: "Pin it · Hit record",
        subtitle: "Just like you'd expect from Loom",
        bullets: ["Pin to the toolbar", "Start recording", "Tab + camera ready"],
        variant: "orange",
        position: "top-right",
      },
    ],
    captions: [
      {
        from: 0,
        durationInFrames: 80,
        text: "Pin it to your toolbar",
      },
      {
        from: 80,
        durationInFrames: 90,
        text: "Just like Loom",
      },
      {
        from: 170,
        durationInFrames: 130,
        text: "Start the recording",
      },
    ],
  },
  {
    kind: "clip",
    file: "04-library.mp4",
    // Source 2:14.00–2:27.00
    seconds: 13,
    popups: [],
    pushovers: [
      {
        from: 20,
        durationInFrames: P,
        side: "right",
        title: "Local library",
        subtitle: "Drive optional — files stay yours",
        bullets: [
          "Recordings land in your library",
          "Connect Google Drive if you want",
          "Or pick a local folder",
        ],
        variant: "orange",
      },
    ],
    captions: [
      {
        from: 0,
        durationInFrames: 80,
        text: "Videos go to your library",
      },
      {
        from: 80,
        durationInFrames: 90,
        text: "Connect Google Drive",
      },
      {
        from: 170,
        durationInFrames: 100,
        text: "Or pick a local folder",
      },
      {
        from: 270,
        durationInFrames: 120,
        text: "Your files · your disk",
      },
    ],
  },
  {
    kind: "clip",
    file: "05-share-cta.mp4",
    // Source 2:52.28–3:03.28
    seconds: 11,
    popups: [
      {
        from: 14,
        durationInFrames: H - 10,
        title: "Share · view counts",
        subtitle: "Loom features — zero Loom bill",
        bullets: [
          "Sharing links when on Drive",
          "See who viewed",
          "Free plugin — no subscription",
        ],
        accentWord: "Share",
        variant: "mint",
        position: "top-left",
      },
    ],
    captions: [
      {
        from: 0,
        durationInFrames: 80,
        text: "Share link · see the views",
      },
      {
        from: 80,
        durationInFrames: 100,
        text: "All the features of Loom",
      },
      {
        from: 180,
        durationInFrames: 150,
        text: "Without a Loom subscription",
      },
    ],
  },
  { kind: "end", seconds: 4.5 },
];

export function secondsToFrames(seconds: number): number {
  return Math.round(seconds * FPS);
}

export function totalDurationInFrames(list: Beat[] = beats): number {
  return list.reduce((sum, b) => sum + secondsToFrames(b.seconds), 0);
}

export const REEL_DURATION_FRAMES = totalDurationInFrames();
