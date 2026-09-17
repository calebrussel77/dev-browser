# Diagnostics, recovery, and install

## The authoritative contract

The exhaustive, versioned, machine-readable contract lives in the CLI itself — consult it rather than guessing flags or memorizing grammar that may have changed:

```bash
dev-browser --help                 # concise command + flag map
dev-browser schema --json          # AUTHORITATIVE: every command, action grammar, wait grammar, error codes, limits
dev-browser capabilities --compact # fast one-line feature discovery
dev-browser examples click         # a focused copy/paste recipe for one command
dev-browser doctor --connect --json  # diagnose CLI/daemon/browser/CDP health with typed recovery codes
```

When behavior is surprising, `doctor` distinguishes daemon vs. browser/CDP vs. renderer failures and tells you the specific recovery step. The CLI also negotiates its runtime/protocol/Playwright/QuickJS provenance on every request and silently restarts an *idle* stale daemon — it never kills in-flight work.

## Lifecycle and recovery

```bash
dev-browser browsers   # list managed + connected instances, their status, and named pages
dev-browser status     # daemon pid, uptime, socket, managed browsers
dev-browser stop       # stop the daemon and close everything it manages
```

If a script fails, the page usually stays where it stopped — reconnect to the same page name, screenshot it, and log the URL/title before deciding anything. Reach for `dev-browser stop` only as deliberate recovery or shutdown; routine runtime mismatches self-heal when the daemon is idle.

If `--connect` reports `<ws connected>` then times out, Chrome/CDP is reachable but Playwright didn't finish attaching: retry with a short `--timeout 10`, then run `dev-browser doctor --connect --json` and follow its recovery command. `--timeout SECONDS` governs *both* the CDP attach step and script execution, so short timeouts fail fast instead of hanging.

## The degraded-daemon signature

A daemon can degrade silently — most often after a CLI invocation was killed from the outside mid-script (a harness timeout, a `kill`), or after very long uptime. Recognize the signature instead of theorizing about the site:

- **Silent output**: a script exits 0 with no stdout. Current builds detect this (`doctor` runs a script round trip and reports `RUNTIME_SELFTEST_FAILED`; a lost output channel exits 6 with `RUNTIME_CHANNEL_LOST`), but treat *any* unexplained empty success as suspect.
- **Frozen reads**: DOM reads that stay byte-identical across scroll steps — `scrollHeight` constant, `scrollY` pinned, one or two feed items forever — while the same URL scrolls fine in a human-driven window. On a covered connected-Chrome window this is the occlusion renderer freeze (reads answer, the page's own JS — timers, rAF, IntersectionObserver, lazy loading — is frozen; `document.visibilityState` still lies "visible"). Scripts now get an automatic wake attempt with a stderr warning; interactive actions already had it.
- **Green health checks**: `status` says connected and the CDP endpoint answers — neither proves a working script pipeline. `doctor` now does (its `ok` includes a real script round trip).

Recovery is always the same and costs seconds: `dev-browser stop`, then retry once. Prevention: pass `--timeout` and keep it comfortably below any supervisor limit governing your process, so an invocation always exits on its own terms; the daemon also aborts a script the moment its submitting CLI dies, so a killed invocation no longer leaves a blind script driving the browser.

Two notes that save detours: plain `window.scrollBy` inside a script's `page.evaluate` is a fine way to drive lazy-loading feeds (one CLI `scroll` call per step is not required — that verb exists for trusted-input scrolling and container scans); and `page.bringToFront()` waking a frozen page once is the occlusion remediation working, not a fix you should build a workflow on.

## Pitfalls checklist

- Prefer `dev-browser --connect` (no URL) for the user's real Chrome; a 404 from `/json/version` is not a failure signal.
- Keep page names stable and descriptive so you can resume after a failure without re-navigating.
- Re-list tabs each run; never hardcode target ids or match tabs by position.
- Never close a tab your automation didn't open.
- After any navigation, submission, or material state change, re-read URL/title (or re-`observe`) instead of assuming success.
- Open every returned `--shot` PNG path before the next consequential action.
- The sandbox is not Node.js: no `require`/`fetch`/`fs`/`process`; file I/O is limited to `~/.dev-browser/tmp/`.
- Use short `--timeout` values (e.g. `--timeout 10`) so scripts fail fast on missing elements or a stuck attach.

## Installation

```bash
npm install -g @calebrussel77/dev-browser
dev-browser install        # installs Playwright + Chromium for managed browsers
```
