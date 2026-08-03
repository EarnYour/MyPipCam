# Luminescent glassmorphism — overlay design notes

Remotion-ready + CapCut-friendly. Pair with brand orange `#ff5e29` and mint `#7ddf9a` on dark UI / colorful desktop.

## Visual recipe

```
Layer stack (top → bottom)
1. Popup / end-card glass (animated)
2. Lower-third glass bar
3. Soft vignette (optional, 8% black)
4. Source clip (talking head or screen)
```

### Glass card CSS tokens

```css
:root {
  --orange: #ff5e29;
  --mint: #7ddf9a;
  --cream: #fafaf7;
  --ink: #111312;
  --glass-bg: rgba(250, 250, 247, 0.12);
  --glass-border: rgba(250, 250, 247, 0.35);
  --glow-orange: 0 0 40px rgba(255, 94, 41, 0.55);
  --glow-mint: 0 0 36px rgba(125, 223, 154, 0.45);
  --blur: 18px;
  --radius: 20px;
  --font-display: "Syne", system-ui, sans-serif;
  --font-body: "Figtree", system-ui, sans-serif;
}

.glass-card {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--blur)) saturate(1.4);
  -webkit-backdrop-filter: blur(var(--blur)) saturate(1.4);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius);
  box-shadow: var(--glow-orange), inset 0 1px 0 rgba(255, 255, 255, 0.25);
  color: var(--cream);
  padding: 18px 24px;
}

.glass-card.mint {
  box-shadow: var(--glow-mint), inset 0 1px 0 rgba(255, 255, 255, 0.25);
  border-color: rgba(125, 223, 154, 0.45);
}

.glass-card h2 {
  font-family: var(--font-display);
  font-weight: 800;
  letter-spacing: -0.02em;
  margin: 0;
}

.glass-card .accent {
  color: var(--orange);
  text-shadow: 0 0 18px rgba(255, 94, 41, 0.65);
}
```

### Motion (Remotion / CSS)

| Element | In | Hold | Out |
| --- | --- | --- | --- |
| Popup | Spring scale 0.92→1, opacity 0→1, 12–18f @30fps | 1.5–2.5s | Fade + slight up 8px |
| Lower-third | Slide from left 24px + fade | Full beat | Slide out left |
| End card | Fade + blur resolve | 6–10s | Fade |

Avoid purple neon / multi-layer drop-shadow stacks. One luminous edge is enough.

### Safe zones

- Keep popups in **left third** over talking-head (desk/lamp side) or **top-right** over screen UI.  
- Never cover face, Share button, or timeline playhead.  
- End card: centered glass plate; URLs ≥ 48px on 1080p.

### SVG glow accent (optional)

```svg
<svg width="280" height="8" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" x2="1">
      <stop offset="0%" stop-color="#ff5e29" stop-opacity="0"/>
      <stop offset="40%" stop-color="#ff5e29"/>
      <stop offset="70%" stop-color="#7ddf9a"/>
      <stop offset="100%" stop-color="#7ddf9a" stop-opacity="0"/>
    </linearGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="2"/></filter>
  </defs>
  <rect width="280" height="8" rx="4" fill="url(#g)" filter="url(#blur)"/>
</svg>
```

## HTML kit

Open [`overlays/preview.html`](./overlays/preview.html) in a browser for live preview.  
Export frames with Remotion or screenshot for CapCut stickers.

## CapCut tips

1. Export popup PNGs with transparency (or screen-record the HTML preview on black → chroma if needed).  
2. Place as overlay → animate Opacity + Scale keyframes.  
3. Color match: orange `#ff5e29` text shadow soft.  
4. Import [`markers-capcut.csv`](./markers-capcut.csv) as a guide for when popups fire.
