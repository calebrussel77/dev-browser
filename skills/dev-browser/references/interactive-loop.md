# The interactive perception-action loop

Everything about driving consequential UI one verb at a time: which command to reach for, the guarantees behind them, and how to read a failure.

## Decision 3 — scripts vs. interactive commands

There are two ways to drive a page. They share the same daemon and pages; choose by task.

**Sandboxed scripts** — pipe JavaScript over stdin (or `dev-browser run file.js`). Best when you know the page and want raw Playwright power: bulk DOM extraction, `page.evaluate`, precise selectors, custom loops. Every page is a full [Playwright `Page`](https://playwright.dev/docs/api/class-page). See `scripting.md`.

**Interactive perception-action commands** — one verb per call (`observe`, `find`, `click`, `type`, `confirm`, ...). Best for *consequential UI you can't fully predict*: forms, messaging flows, anything where you must look, decide, act, and verify. These return compact structured state with stable element **refs** and coordinates, use **trusted** OS-level mouse/keyboard input (never `HTMLElement.click()`), and guard every action. This is the recommended path for anything irreversible.

Rule of thumb: **known page and selectors → script; unknown or high-stakes UI → interactive loop.** You can freely mix them on the same page.

## The loop

The loop is: **perceive → find → act → verify**, one step per command, opening any returned screenshot before the next consequential action. A canonical sequence (site-agnostic):

```bash
dev-browser --connect pages                                   # 1. discover tabs
dev-browser --connect observe --page TARGET --annotate --shot before.png   # 2. perceive: refs + coords
dev-browser --connect find --page TARGET --role button --name "Connect" --name-mode exact --within main   # 3. pick the exact element
dev-browser --connect click --page TARGET --ref R12 --from-state doc-7:184 --wait-text "visible,body,contains,Add a note"   # 4. act + wait
dev-browser --connect confirm --page TARGET --ref F0:R14 --expect "Jane Doe"   # 5. verify recipient before an irreversible click
dev-browser --connect click --page TARGET --ref F0:R14 --from-state doc-7:190 --confirm-token TOKEN   # 6. final guarded action
```

What each group of commands is for (run `dev-browser examples COMMAND` for a focused recipe, and `dev-browser --help` for the full flag list):

- **Perceive** — `observe` (compact actionable tree with refs, coordinates, and `main`/`aside`/`dialog` landmark paths), `read` (accessibility snapshot), `text` (bounded normalized text of a ref or scope). Scope any of them with `--within main` / `--within role:button` / `--within name:"Exact Name"` (or `observe --root REF`) to spend the node budget on the relevant subtree instead of re-reading page chrome.
- **Find** — `find` takes a *fresh* snapshot every call and ranks elements. Combine `--role`, `--name`, `--name-mode exact|contains`, `--within`, `--near`, `--frame`, `--scope`, and repeated `--state` to disambiguate duplicate labels deterministically. Results carry match reasons, confidence, ambiguity, and actionability. Use `--index` only as a last resort.
- **Act** — `click`, `type`, `focus`, `press`, `paste`, `scroll`, `select`, `check`/`uncheck`, `hover`, `drag`, `upload`, plus navigation (`navigate`, `back`, `forward`, `reload`). All take a `--ref` (or `--xy X,Y` for click) and refresh the page state on return.
- **Verify** — `assert` (fail with a typed `ASSERTION_FAILED` and *no* input attempt if expected text is absent), `confirm` (check dialog/recipient text before the final click), `shot` (screenshot to an absolute PNG path).

Refs are `R#` or `F#:R#` (framed); page state ids are `doc-#:revision`. **Refs and states go stale** when the DOM rerenders — re-`observe`/`find` and use the fresh values rather than reusing old ones. All coordinates (screenshot pixels, ref boxes, `--xy`) are **CSS pixels**, regardless of device pixel ratio or scroll.

## Correctness and safety features

These exist because "the click returned 200" is not the same as "the thing happened." Lean on them for anything that matters.

- **Trusted input.** Actions dispatch real Playwright mouse/keyboard events, so sites that ignore synthetic `click()` behave correctly.
- **State guards.** Pass `--from-state doc-#:rev` so an action refuses to run if the page changed under you (stale-state protection). Actions also reject stale refs, ambiguity, hidden/obscured/disabled targets, and lease conflicts — each with a typed, recoverable error.
- **Confirmation tokens** for irreversible actions. `confirm --ref REF --expect "Recipient"` returns a token that is daemon-scoped, single-use, bound to the exact page/document/target/URL, and expires in 30 seconds. Consume it on the final action with `--from-state STATE --confirm-token TOKEN`. An invalid/expired/reused/out-of-scope token returns `CONFIRMATION_INVALID` (exit status 8) — the action does **not** fire.
- **Typed, event-driven waits.** Attach `--wait-*` conditions (text, URL, ref state, dialog, toast, popup, download, file chooser, navigation, response, failed request, network idle) so a command blocks on the real outcome instead of a blind sleep. See the wait grammar in `dev-browser schema --json`.
- **Safe retries.** `--retry safe` retries only with strong evidence the prior attempt had no side effect; guarded or irreversible actions are never silently duplicated.

**Error codes and exit statuses** (the full, authoritative list is in `dev-browser schema --json`):

| Exit | Family | Example codes |
| --- | --- | --- |
| 3 | Actionability / assertion / input | `STALE_REF`, `STALE_STATE`, `AMBIGUOUS_TARGET`, `TARGET_MISSING`, `TARGET_HIDDEN`, `TARGET_OBSCURED`, `TARGET_DISABLED`, `ASSERTION_FAILED`, `INPUT_VALUE_MISMATCH` |
| 4 | Wait | `WAIT_TIMEOUT` |
| 5 | Lease | `LEASE_CONFLICT` |
| 6 | Runtime | `CDP_ATTACH_FAILED`, `RENDERER_UNRESPONSIVE`, `WINDOW_OCCLUDED`, `PAGE_CLOSED`, ... |
| 8 | Confirmation | `CONFIRMATION_INVALID` |

## Features worth knowing (they solve specific, painful problems)

- **React-safe `type`.** `type` inspects the field and enters text the way that element commits it: the native value setter plus composed `beforeinput`/`input`/`change` events for `input`/`textarea` (so controlled React components register the change), or `keyboard.insertText` for `contenteditable` — with an automatic fall back to real key-by-key typing when a rich-text editor (Draft.js / Lexical, e.g. LinkedIn's composer) drops a bulk insert. It rereads the value afterward and returns `INPUT_VALUE_MISMATCH` instead of a false success if it didn't take. `--clear` replaces existing content; without it, entry appends.
- **Virtualized / infinite-scroll containers.** A recycled list keeps only a few DOM nodes for hundreds of logical rows, so one snapshot can't see them all. `scroll --ref CONTAINER --until "text:Conversation 47" --max-steps 20` and `find --scroll-container CONTAINER --max-steps N` scroll the container itself (trusted wheel over it, not `scrollIntoView`) and re-perceive after each step. Results include `scrollMetrics` so you can tell a genuinely short list from one that just stopped yielding new rows.
- **Bounded screenshots.** Every capture has a hard deadline (`--shot-timeout MS`, 250..120000, default `min(--timeout, 8000)`). Capture prefers a single CDP `Page.captureScreenshot` so it never hangs on perpetual CSS animation, a blinking caret, or `document.fonts.ready`; result metadata reports `captureMode: "cdp" | "playwright"`.
- **`--trace`** persists a redacted, size-bounded action journal (timing, before/after state, input method, waits, retries, network/lifecycle) under `~/.dev-browser/tmp/traces`; read the latest with `dev-browser trace show LAST`. Use it only when you need the detail.
