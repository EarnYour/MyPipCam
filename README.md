# MyPipCam

Monorepo for **MyPipCam**: a Loom-style camera PiP experience across macOS and (soon) Chrome.

| Path | What |
| --- | --- |
| [`apps/macos`](apps/macos) | macOS companion app — floating always-on-top camera bubble for OBS / desktop recording |
| [`apps/extension`](apps/extension) | Chrome extension (upcoming) — in-browser screen + camera PiP recording, library, and trim editor |

## macOS app

A Loom-style floating camera bubble for macOS. Point it at your OBS Virtual Camera (or any webcam), drag it around, and screen-record in OBS for that picture-in-picture feel.

### Features

- Circular always-on-top camera bubble
- Drag anywhere to move
- Scroll while hovering to resize
- Camera picker (OBS Virtual Camera, FaceTime, Continuity Camera, etc.)
- Border color presets + soft Loom-like drop shadow
- Mirror toggle
- Menu bar icon to show/quit (no Dock icon)

### Setup

1. Open `apps/macos/MyPipCam.xcodeproj` in Xcode
2. Select your signing team under **Signing & Capabilities** (or leave empty for local run)
3. Press **Run** (⌘R)
4. Allow camera access when prompted
5. In OBS: **Start Virtual Camera**
6. Hover the bubble → camera icon → choose **OBS Virtual Camera**

### OBS recording tip

Record your display/screen in OBS as usual. MyPipCam sits on top of your desktop as a real window, so it appears in the recording with you inside the circle.

### Controls

| Action | How |
| --- | --- |
| Move | Drag the bubble |
| Resize | Scroll while hovering, or right-click → Size |
| Switch camera | Hover → video icon, or right-click → Camera |
| Border color | Hover → palette icon, or right-click → Border Color |
| Shadow / mirror | Right-click the bubble |
| Quit | Hover → ✕, menu bar icon → Quit, or right-click → Quit |
| Open at Login | Menu bar icon → Open at Login, or right-click the bubble |

### Requirements

- macOS 14+
- Xcode 16+
- Camera permission
- OBS Virtual Camera (optional, if that's your source)

## Chrome extension

Scaffold and recording pipeline land in a later phase. Placeholder: `apps/extension/`.
