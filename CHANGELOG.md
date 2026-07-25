# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Added video recording of browser sessions on both surfaces. `dev-browser video start [FILE]`, `dev-browser video chapter TITLE`, and `dev-browser video stop` record the targeted page to a playable WebM file, with the recording state living in the daemon so navigation, clicks, and chapter markers interleave freely between separate CLI invocations; both `start` and `stop` return the absolute output path, an omitted `FILE` defaults to `~/.dev-browser/tmp/videos/<page>-<timestamp>.webm`, and a relative `FILE` resolves against the caller's working directory. One recording per page (a second `start` fails with `VIDEO_ALREADY_RECORDING`), while distinct pages record in parallel. Every recording carries a max duration (default 600s, `--max-duration SECONDS`) after which the daemon finalizes the file on its own and reports `VIDEO_LIMIT_REACHED` on the next video command for that page; recordings are also finalized gracefully when the page closes, when a browser is stopped, and on daemon shutdown, so the output is always a valid `.webm`. Recording a connected Chrome first wakes an occluded window with the same remediation used before trusted input. Sandboxed scripts get the full `page.screencast` surface — `start({ path, size })`, `stop()`, `showChapter()`, `showOverlay()` with disposables, `hideOverlays()`/`showOverlays()` — for paced hero videos with annotations; `start({ onFrame })` is explicitly unsupported in the sandbox. Video commands are declared in `dev-browser schema --json` and `dev-browser capabilities`, `dev-browser examples video` returns a focused recipe, and the skill ships a dedicated video-recording reference.
- Restructured the dev-browser skill into progressive-disclosure format: a lean `SKILL.md` plus `references/` files loaded on demand. `dev-browser install-skill` now installs the whole skill directory.
- Detect and auto-remediate occluded connected-Chrome windows before trusted input. When the driven window is fully covered by other windows (and not foreground), Chrome freezes its renderer: reads keep working but clicks/typing are silently dropped or time out. The daemon now probes frame production before every trusted-input action on connected browsers, wakes the window through a CDP minimize/restore (the only wake-up that works against a fully covered window), hands focus straight back to the previously active window on Windows, and reports the remediation as a warning. When remediation fails it raises an explicit `WINDOW_OCCLUDED` error (exit status 6) instead of a generic timeout, recommending `--disable-backgrounding-occluded-windows` for the connected Chrome. Launched browsers already carry that flag via Playwright and are unaffected.

## [0.2.7] - 2026-04-09

- Updated documentation to recommend `domcontentloaded` for dev server navigation.

## [0.2.6] - 2026-03-30

- Pinned Playwright version.

## [0.2.5] - 2026-03-30

- Updated Windows documentation with PowerShell examples.
- Use null viewport for headed mode.

## [0.2.4] - 2026-03-26

- Added `--ignore-https-errors` flag for self-signed certificates.

## [0.2.3] - 2026-03-25

- Added Windows x64 compatibility.

## [0.2.1] - 2026-03-19

- Added an interactive `install-skill` TUI command to install the skill into `~/.claude/skills/` and `~/.agents/skills/`.
- Added a `--timeout` flag for script execution with a 30-second default.
- Documented `page.snapshotForAI()` for LLM-friendly page inspection.
- Expanded the `--help` LLM usage guide with approach guidance, screenshots, waiting patterns, and error recovery.
- Simplified the README, added a Windows-not-supported note, and attributed Do Browser.
- Aligned marketplace versioning with `package.json` and added auto-sync support.
- Added `rustfmt` and Prettier plus CI format checks.

## [0.2.0] - 2026-03-19

Initial CLI release.
