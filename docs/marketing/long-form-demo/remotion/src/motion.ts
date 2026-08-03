import { Easing } from "remotion";

/**
 * Motion curves adapted from:
 * - Chronixel Style Vault (CHRON_STYLE_22 Night Drive HUD · CHRON_STYLE_20 Dark Dashboard)
 *   + Scene Composition “clean glass panels snap into alignment”
 * - nmsn Remotion broadcast easing (`Cursor/nmsn/remotion/src/lib/easing.ts`)
 * - MyPipCam OVERLAY_DESIGN.md (slower glass holds)
 */

/** Hard expo-out — fast launch, soft landing into rest. */
export const EASE_OUT_EXPO = Easing.bezier(0.16, 1, 0.3, 1);

/** Gentle in-out for panel push / layout shifts. */
export const EASE_IN_OUT_QUART = Easing.bezier(0.76, 0, 0.24, 1);

/** Soft overshoot for glass popups. */
export const EASE_OUT_BACK = Easing.bezier(0.34, 1.56, 0.64, 1);

/** Exit acceleration for overlays. */
export const EASE_IN_EXPO = Easing.bezier(0.7, 0, 0.84, 0);

/** Slower glass enter — readable product callouts. */
export const glassSpring = {
  damping: 16,
  mass: 0.9,
  stiffness: 95,
  overshootClamping: false,
} as const;

/** Snappy accent bar / bullet stagger. */
export const snappySpring = {
  damping: 14,
  mass: 0.7,
  stiffness: 160,
  overshootClamping: false,
} as const;

/** Full-panel push-over settle. */
export const panelSpring = {
  damping: 18,
  mass: 1.05,
  stiffness: 85,
  overshootClamping: false,
} as const;

/** Default popup hold length @ 30fps (~4.2s readable). */
export const POPUP_HOLD_FRAMES = 126;

/** Push-over hold @ 30fps (~5.2s for bullet panels). */
export const PUSHOVER_HOLD_FRAMES = 156;
