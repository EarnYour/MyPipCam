# Rough cut sheet — first 42 minutes

Scene detect: `ffmpeg select=gt(scene\,0.35)` on 0–2520s.  
Early footage is a continuous talking-head take (few hard cuts). Chapter titles below mix **scene hits** + **preview-frame labeling**.

Timestamps are **source MOV** times (`hh:mm:ss`).

## Chapter map (suggested)

| Chapter | Source in | Source out | Suggested title | Notes |
| --- | --- | --- | --- | --- |
| Hook | 00:00:00 | 00:00:45 | Hook — “Replace Loom for free” | Talking head cold open; punchy VO / overlays |
| Problem | 00:05:00 | 00:06:30 | Problem — Loom bills & lock-in | Talking head; popup “No Loom bill” |
| Install | 00:29:45 | 00:31:30 | Install — GitHub in 60s | Releases page + circular PiP; show zip / Load unpacked |
| Record | 00:24:20 | 00:25:30 | Record — Tab + Cam PiP | Library / just-finished recording energy |
| PiP | 00:27:35 | 00:28:30 | PiP — macOS bubble that floats | Right-click Size / Shape / Record… |
| Library | 00:39:15 | 00:40:10 | Library — local + Drive | Grid with DRIVE badges, “Link ready” |
| Editor | 00:36:50 | 00:38:00 | Editor — cut silence, export | Timeline Keep/Cut + Download |
| Desktop Record | 00:23:50 | 00:24:25 | Desktop — when you leave Chrome | OBS→desktop bridge (trim hall-of-mirrors) |
| CTA | 00:40:30 | 00:41:30 | CTA — install free | End card: site + releases; “Free forever” |

## Scene-change hits (deduped, score ≥ ~0.35)

| Time | Score | Likely beat |
| --- | --- | --- |
| 23:54.7 | 0.36 | Enter desktop / OBS |
| 24:22.8 | 1.00 | Hard UI change |
| 24:46.9 | 1.00 | Library / player |
| 25:10.1 | 1.00 | Detail / Share |
| 26:19.3 | 0.41 | Soft cut |
| 27:44.9 | 0.35 | macOS PiP menu |
| 33:56.2 | 1.00 | GitHub Releases focus |
| 34:14.9 | 0.90 | Install scroll |
| 34:26.2 | 0.71 | Install step |
| 35:02.4 | 1.00 | Library Settings |
| 35:31.9 | 0.87 | Settings / Drive |
| 35:49.9 | 0.53 | Soft |
| 37:00.5 | 0.42 | Editor enter |
| 37:25.5 | 1.00 | Editor timeline |
| 37:48.2 | 1.00 | Export |
| 38:14.8 | 1.00 | Export / download |
| 38:29.9 | 0.48 | Soft |
| 39:21.2 | 1.00 | Library grid |
| 39:29.7 | 1.00 | Grid / share status |
| 40:48.3 | 0.50 | Tip / support |
| 41:09.2 | 0.53 | Soft |
| 41:24.2 | 0.50 | Soft / end of demo window |

Machine-readable: [`scene_cuts.tsv`](./scene_cuts.tsv).

## Highlight clips (already extracted)

| Clip | Source start | Duration | File |
| --- | --- | --- | --- |
| Hook | 0:00 | 45s | [`clips/01-hook-talking-head.mp4`](./clips/01-hook-talking-head.mp4) |
| Problem | 5:00 | 40s | [`clips/02-problem-talking-head.mp4`](./clips/02-problem-talking-head.mp4) |
| Screen enters | 23:50 | 35s | [`clips/03-screen-enters.mp4`](./clips/03-screen-enters.mp4) |
| Library detail | 24:40 | 45s | [`clips/04-library-detail.mp4`](./clips/04-library-detail.mp4) |
| macOS PiP menu | 27:35 | 40s | [`clips/05-macos-pip-menu.mp4`](./clips/05-macos-pip-menu.mp4) |
| Install + PiP | 29:45 | 50s | [`clips/06-install-github-pip.mp4`](./clips/06-install-github-pip.mp4) |
| Settings / Drive | 34:55 | 40s | [`clips/07-library-settings-drive.mp4`](./clips/07-library-settings-drive.mp4) |
| Editor export | 36:50 | 45s | [`clips/08-editor-export.mp4`](./clips/08-editor-export.mp4) |
| Library CTA | 39:15 | 40s | [`clips/09-library-grid-cta.mp4`](./clips/09-library-grid-cta.mp4) |

Re-extract: `./scripts/extract-clips.sh` (see package README).

## CapCut / Final Cut markers (CSV)

Import as markers or use as a paper edit. Times relative to **source MOV**.

```csv
Name,Start,End,Notes
Hook,00:00:00,00:00:45,Talking head + glass title
Problem,00:05:00,00:06:30,Popup No Loom bill
Desktop enter,00:23:50,00:24:25,Trim OBS recursion
Library detail,00:24:40,00:25:30,Share orange CTA
macOS PiP,00:27:35,00:28:30,Size menu callout
Install,00:29:45,00:31:30,GitHub releases
Settings Drive,00:34:55,00:36:00,Connected badge
Editor,00:36:50,00:38:00,Cut timeline
Library grid,00:39:15,00:40:10,DRIVE badges
CTA tip,00:40:30,00:41:30,End card overlay
```

Also saved as [`markers-capcut.csv`](./markers-capcut.csv).
