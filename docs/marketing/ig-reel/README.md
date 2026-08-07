# MyPipCam — Instagram / Facebook Reel

Vertical **1080×1920** cut from the 2026-08-07 publish demo, with burned-in captions, glass popup callouts, and side-push panels (overlay language shared with `../long-form-demo/remotion`).

| Artifact | Path |
| --- | --- |
| Beat sheet | [`BEAT_SHEET.md`](./BEAT_SHEET.md) |
| Transcript | `transcript/source.{txt,srt,vtt}` |
| Clips | `clips/*.mp4` |
| Remotion | `remotion/` |
| Rendered MP4 | `output/MyPipCam-ig-fb-reel.mp4` |

## Render

```bash
cd docs/marketing/ig-reel/remotion
npm install
npm run render
```

Preview: `npm start` → composition **IgFbReel**.

## Re-transcribe

```bash
ffmpeg -y -i "/path/to/source.mov" -vn -acodec pcm_s16le -ar 16000 -ac 1 transcript/source.wav
whisper-cli -m models/ggml-base.en.bin -l en -osrt -ovtt -otxt \
  -of transcript/source transcript/source.wav
```
