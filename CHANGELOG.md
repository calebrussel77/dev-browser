# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Added `click --require-ancestor-text TEXT` (ref clicks only): an in-page addressing guard for irreversible controls that open no dialog. The daemon resolves the target, walks up to its nearest self-contained card ancestor (`article`, `li`, `[role=listitem]`, `dialog`, `section`, ..., or the outermost block inside the enclosing landmark), and refuses to click — typed `ASSERTION_FAILED` (exit 3), no input dispatched — unless that card's text contains the required value. The result reports `ancestorGuard: { matched, card }`, and the required text is redacted from output like `--expect-text`. This fails closed on duplicate-label lookalikes (e.g. a sidebar of "Connect" buttons for other people).
- Added `find --root REF`: scope find's collection to a subtree obtained from `observe`, so hard collection caps are spent inside it (mutually exclusive with `--scroll-container`; a missing or stale root fails typed instead of silently widening). The `budget-exhausted` warning now recommends it.
- Raised the per-frame collection work cap from 5,000 to 20,000 visited elements; ordinary LinkedIn-sized documents no longer hide late-DOM content (e.g. open overflow menus) behind `budget-exhausted`.
- `--wait-dialog`, `--wait-toast`, and `--wait-navigation` values are now case-insensitive (help shows uppercase placeholders), and their errors echo the received value.
- `text` and `assert` now report their scope as a choice (`--ref` or `--within`) instead of listing both as required; `click` and `navigate` do the same for their target forms.
- The ambiguous `--within` scope error now tailors its advice to what was already tried (no more "refine with role:" after `role:` was used) and mentions `--root REF`.
- Fixed `find` silently missing on-screen elements on large pages. `find` (and `find --scroll-container`) now matches against the full collected snapshot instead of the display-budgeted tree selection, so mid-page elements that a default `observe` elides (deep nesting, heavy chrome) are found and their refs remain directly actionable. The result carries a new `search: { candidates, truncated }` field reporting coverage, and an empty result after a collection that hit a hard cap is reported as `ambiguity.reason: "budget-exhausted"` with a warning instead of a misleading `"no-match"` — `"no-match"` now always means the traversal completed and the element genuinely is absent. Annotated `find --shot` screenshots also box matches beyond the display budget.
- The "Absolute paths are not allowed" errors for controlled temp files now say where relative paths land (`~/.dev-browser/tmp`) and that the result reports the absolute path.
- `navigate` accepts the URL as `--url URL` in addition to the positional form.
- Documented that the same logical action can take different UI paths on the same site (e.g. a primary button vs. an overflow menu), and that `find` matching is independent of `observe` display budgets.
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
