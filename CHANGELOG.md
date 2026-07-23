# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
