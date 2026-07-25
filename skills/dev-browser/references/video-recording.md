# Video recording

Record a page to a playable WebM file — a QA journey, a proof of work, or a demo a human can watch. Two paths: quick CLI commands for an ad-hoc capture, and a hero script when the video needs pacing and annotations.

Recording is backed by Playwright's `page.screencast` and its bundled ffmpeg encoder. The output is standard WebM (VP8), playable in any browser or player.

## The quick CLI path

Recording state lives in the daemon, so you interleave normal commands between the video ones.

```bash
dev-browser --connect video start recordings/login-flow.webm --page TARGET --size 1280x800
dev-browser --connect video chapter "Sign in" --page TARGET --description "Entering credentials" --duration 2000
dev-browser --connect click --page TARGET --ref R12
dev-browser --connect type  --page TARGET --ref R13 --text "user@example.com"
dev-browser --connect video chapter "Result" --page TARGET --description "Landing on the dashboard"
dev-browser --connect video stop --page TARGET
```

- `video start [FILE]` begins recording the targeted page and returns the **absolute** output path in its JSON result. Omit `FILE` and the recording lands in `~/.dev-browser/tmp/videos/<page>-<timestamp>.webm`. A relative `FILE` resolves against *your* working directory, not the daemon's.
- `--size WxH` fixes the recorded dimensions regardless of the live viewport.
- `--max-duration SECONDS` overrides the default 600-second cap (see Limitations).
- `video chapter TITLE` inserts a full-screen chapter card — blurred backdrop, title, optional `--description` — into the active recording. It blocks for `--duration` milliseconds (default 2000) so the card is actually on screen in the finished video.
- `video stop` finalizes the recording and returns the same absolute path.

One active recording per page. Two *different* pages can record at the same time, each to its own file.

## The hero-script path

When the video is for a human, drive it from a script: you control pacing, type character by character, and annotate what is happening. `page.screencast` is available on every sandboxed page.

```bash
dev-browser --connect <<'EOF'
const page = await browser.getPage("main");
await page.screencast.start({ path: "todo-demo.webm", size: { width: 1280, height: 800 } });
await page.goto("https://demo.playwright.dev/todomvc", { waitUntil: "domcontentloaded" });

// Chapter card: blurs the page, shows the title, blocks for its duration, then removes itself.
await page.screencast.showChapter("Adding Todo Items", {
  description: "We will add several items to the todo list.",
  duration: 2000,
});

const input = page.getByRole("textbox", { name: "What needs to be done?" });
await input.pressSequentially("Walk the dog", { delay: 60 });
await input.press("Enter");
await page.waitForTimeout(1000);

// Sticky annotation: stays visible across later actions until disposed.
const annotation = await page.screencast.showOverlay(`
  <div style="position: absolute; top: 8px; right: 8px;
    padding: 6px 12px; background: rgba(0,0,0,0.7);
    border-radius: 8px; font-size: 13px; color: white;">
    ✓ Item added successfully
  </div>
`);

await input.pressSequentially("Buy groceries", { delay: 60 });
await input.press("Enter");
await page.waitForTimeout(1500);
await annotation.dispose();

// Positioned overlay: highlight a real element by its bounding box.
const bounds = await page.getByText("Walk the dog").boundingBox();
await page.screencast.showOverlay(`
  <div style="position: absolute; top: ${bounds.y}px; left: ${bounds.x}px;
    width: ${bounds.width}px; height: ${bounds.height}px; border: 1px solid red;"></div>
`, { duration: 2000 });

await page.screencast.stop();
console.json({ done: true });
EOF
```

**Overlays are `pointer-events: none`** — they never intercept clicks, fills, or any other action, so it is safe to keep a sticky overlay up while the automation keeps working.

Because a script runs in the sandbox, `path` is a *name*, not a host path: the file is reserved under `~/.dev-browser/tmp/videos/` and the absolute path is where it lands. Use the CLI path when you need the recording written to a directory you choose.

### Overlay API summary

| Method | Use case |
| --- | --- |
| `page.screencast.start({ path, size })` | Begin recording; returns a disposable that stops the recording |
| `page.screencast.stop()` | Finalize and save the recording |
| `page.screencast.showChapter(title, { description?, duration?, styleSheet? })` | Full-screen chapter card with blurred backdrop — section transitions |
| `page.screencast.showOverlay(html, { duration? })` | Custom HTML overlay — callouts, labels, highlights; returns a disposable |
| `disposable.dispose()` | Remove a sticky overlay added without a duration |
| `page.screencast.hideOverlays()` / `showOverlays()` | Temporarily clear all annotations for a clean shot, then restore them |

## Recording the user's real Chrome

Recording a `--connect`ed Chrome is where video is most valuable — the session is genuinely logged in. `video start` first wakes the window if it is occluded (the same remediation used before trusted input), so recordings do not begin on frozen or black frames.

## Limitations

State these to yourself before recording, not after watching a broken video:

- **Popups and new tabs are not captured.** The recording follows the page you started it on. If the flow opens a new tab, that tab is not in the video.
- **A connected window must stay visible.** Chrome only composes frames for a visible window. If the user covers or minimizes the recorded window mid-recording, the picture freezes and the encoder pads the last frame until it is visible again. The wake at `video start` fixes the starting state, not what happens afterwards.
- **Recordings auto-finalize at the max duration** (default 600 seconds, `--max-duration SECONDS` to change it). When the cap fires, the daemon finalizes the file on its own; the next `video` command for that page reports `VIDEO_LIMIT_REACHED` so you know why nothing was running.
- **`onFrame` is unavailable in the sandbox.** `screencast.start({ onFrame })` throws an explicit unsupported error — no frame data crosses the QuickJS bridge. Record to a file instead.
- **No audio, no format or codec options.** The deliverable is a WebM file; the encoder is used as-is.
- Recording adds a small amount of overhead, and long recordings consume real disk space.

## Errors

All video errors are typed and exit with status 6:

| Code | Meaning |
| --- | --- |
| `VIDEO_ALREADY_RECORDING` | A second `video start` on a page that is already recording |
| `VIDEO_NOT_RECORDING` | `video chapter` or `video stop` with nothing running on that page |
| `VIDEO_LIMIT_REACHED` | The recording was finalized by its max-duration cap |
| `VIDEO_ENCODER_MISSING` | Playwright's ffmpeg is not installed — run `dev-browser install` |

When an error concerns a file, its absolute path is in `error.details.path` — the message itself carries no path, because free-text messages are home-directory redacted.

## Video vs. trace

| | Video | `--trace` |
| --- | --- | --- |
| Output | WebM file | Redacted JSON action journal |
| Shows | What it looked like | State, timing, waits, retries, network |
| Use for | Demos, proof of work, handover | Debugging why an action behaved oddly |
| Size | Larger | Bounded and small |
