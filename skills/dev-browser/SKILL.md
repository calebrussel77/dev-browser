---
name: dev-browser
description: Drive a real Chrome/Chromium from the command line with sandboxed JavaScript and a trusted perception-action loop. Use this whenever the user wants to navigate a website, click, fill or submit a form, take a screenshot, scrape or extract data from pages, test or debug a web app, log into a site, or automate any multi-step browser workflow. Reach for it especially when the work needs a real logged-in session, several tabs open on the same profile at once (e.g. scraping one account across Instagram/Facebook/LinkedIn tabs), or persistent state that survives across scripts. Trigger phrases include "go to [url]", "click on", "fill out the form", "take a screenshot", "scrape", "extract the profiles", "automate", "test the website", "log into", "connect to my Chrome", or any request that ends in operating a browser.
---

# Dev Browser

Dev Browser drives a real Chrome or Chromium browser from the terminal. You send it JavaScript (run in a locked-down sandbox) or single-purpose CLI commands (`observe`, `find`, `click`, `type`, ...), and it returns structured JSON plus optional screenshots.

## Mental model — read this first

Three moving parts, and understanding them prevents almost every mistake:

- **The CLI** (`dev-browser`) is what you invoke. It is stateless: each call is one request.
- **A background daemon** holds all the real state — the live browser(s), the open tabs, and the CDP connections. It starts automatically on the first command and keeps running between your commands. This is why *the browser and its pages stay alive between calls*: you navigate in one command and interact in the next without re-loading anything.
- **A QuickJS WASM sandbox** runs your scripts. It is **not** Node.js. There is no `require`, `import`, `fetch`, `process`, `fs`, or `path`. File I/O is limited to three helper functions writing under `~/.dev-browser/tmp/`. A script that reaches for Node APIs fails, and the reported line number is often off by a bit, so recognize the cause rather than trusting the trace.

Because the daemon persists state, think in **small, focused commands** that each do one thing and end by reporting the state you need for the next decision — not one giant script. Short commands fail fast, are easy to retry, and keep the browser exactly where it stopped when something goes wrong.

## Decision 1 — which browser to drive

This is the first and most consequential choice. Pick from the *task*, not by habit.

| You want... | Use | What you get |
| --- | --- | --- |
| The user's real Chrome, with their logins, cookies, and open tabs | `dev-browser --connect` | Attaches over CDP to a running Chrome. Shares the user's session. Multiple tabs, one profile (see below). |
| A specific CDP endpoint you were handed | `dev-browser --connect http://localhost:9222` (or a `ws://...` URL) | Same as above, but no auto-discovery. |
| A clean, isolated, *persistent* automation profile | `dev-browser --browser <task-name>` | A dedicated Chromium profile at `~/.dev-browser/<task-name>/chromium-profile`. Its own cookie jar and login state, kept between runs, isolated from every other name. |
| Disposable unattended automation | `dev-browser --browser <name> --headless` | A managed profile with no visible window. |

Key consequences to internalize:

- **`--connect` auto-discovery is robust.** Prefer `dev-browser --connect` with *no URL*: the daemon reads Chrome's `DevToolsActivePort` file and probes common CDP ports. This matters because Chrome can expose a working CDP WebSocket while `http://localhost:9222/json/version` still returns 404 — a bare 404 is **not** proof that CDP is unusable. To make a Chrome connectable, launch it with `chrome.exe --remote-debugging-port=9222` (or `google-chrome --remote-debugging-port=9222`).
- **`--headless` and `--ignore-https-errors` only affect *managed* browsers** (`--browser`). They do nothing to an external Chrome reached through `--connect` — you cannot make someone's already-open Chrome headless.
- **Each `--browser <name>` is a separate persistent profile.** Reusing a name resumes that exact profile, logins and all. Use stable, descriptive names (`--browser linkedin-scrape`), not throwaways.
- **`--connect` never launches Chrome for you.** If nothing is listening, it reports a discovery/attach failure; start Chrome with a debugging port first.

## Decision 2 — the same-profile, many-tabs model (the core strength)

This is the capability most people underuse. A browser you drive — whether the user's connected Chrome or a managed profile — is **one profile = one cookie jar = one authenticated session**. Every tab inside it shares that session. Dev Browser lets you address any number of those tabs individually while they all stay logged in as the same person.

Concretely, a *page* is addressed one of two ways, and both live in the same shared context:

- **A named page** — `browser.getPage("feed")` in a script, or `--page feed` on a command. The name is yours. The first use opens (or, when connecting, reuses) a tab; every later use with the same name returns that same tab. Named pages **persist across script runs** for the lifetime of that browser, so you navigate once and keep interacting run after run without re-loading.
- **An existing tab by target id** — `browser.getPage("<targetId>")` / `--page <targetId>`. You get the ids from `listPages()` / the `pages` command. This attaches to a tab that already exists (including tabs the user opened themselves). In `--connect` mode, dev-browser attaches **only the target you name**, not every renderer — which is what makes a heavily loaded Chrome (dozens of tabs) usable instead of overwhelming.

Why this matters, with a real shape of work: you connect to one logged-in Chrome and drive several tabs at once — a `profiles` tab paging through search results, a `detail` tab opening individual pages, an `export` tab — all sharing the single login. You never re-authenticate, and each tab is independently perceivable and clickable. For a scraping pipeline against one account, this is the whole game: one session, many concurrent working surfaces.

Discovery and hygiene commands:

```bash
# List every tab in the profile: named pages AND the user's own tabs.
# Returns [{ id, url, title, name }]; name is null for tabs you didn't name.
dev-browser --connect pages
```

```javascript
// Same thing inside a script, then attach to a specific one.
const tabs = await browser.listPages();
const target = tabs.find(t => t.url.includes("app.example.com"));
const page = await browser.getPage(target.id);   // attach that exact tab
```

Rules that keep this safe and predictable:

- **Never close a tab you did not open.** `browser.closePage(name)` and closing only apply to pages your automation created (or that the user explicitly asked to close). When connecting, dev-browser deliberately leaves the user's existing tabs *unnamed* so a stray `getPage("main")` opens a fresh tab instead of hijacking one of theirs.
- **Don't hardcode target ids across runs.** Re-list with `pages` / `listPages()` each time. Ids are re-enumerated, and a restart of a *managed* browser gives entirely new ones. Match tabs by **both** URL and title (either can be stale or duplicated), never by position.
- **`browser.newPage()`** makes an anonymous tab that is cleaned up when the script exits — use it for throwaway work, not for state you want to keep.

## Decision 3 — scripts vs. interactive commands

There are two ways to drive a page. They share the same daemon and pages; choose by task.

**Sandboxed scripts** — pipe JavaScript over stdin (or `dev-browser run file.js`). Best when you know the page and want raw Playwright power: bulk DOM extraction, `page.evaluate`, precise selectors, custom loops. Every page is a full [Playwright `Page`](https://playwright.dev/docs/api/class-page).

```bash
dev-browser --connect <<'EOF'
const page = await browser.getPage("main");
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
console.json({ title: await page.title(), url: page.url() });
EOF
```

**Interactive perception-action commands** — one verb per call (`observe`, `find`, `click`, `type`, `confirm`, ...). Best for *consequential UI you can't fully predict*: forms, messaging flows, anything where you must look, decide, act, and verify. These return compact structured state with stable element **refs** and coordinates, use **trusted** OS-level mouse/keyboard input (never `HTMLElement.click()`), and guard every action. This is the recommended path for anything irreversible.

Rule of thumb: **known page and selectors → script; unknown or high-stakes UI → interactive loop.** You can freely mix them on the same page.

## The interactive perception-action loop

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
- **`console.json(value)`** emits exactly one bounded, parseable JSON line (via the sandbox's own `JSON.stringify`, rejecting circular refs and oversized >64 KiB values cleanly). Prefer it over `console.log(JSON.stringify(...))` whenever a caller must parse one line.
- **`page.snapshotForAI({ track?, depth?, timeout? })`** in scripts returns `{ full, incremental? }`, an AI-optimized structural snapshot for element discovery on unknown pages.
- **`--trace`** persists a redacted, size-bounded action journal (timing, before/after state, input method, waits, retries, network/lifecycle) under `~/.dev-browser/tmp/traces`; read the latest with `dev-browser trace show LAST`. Use it only when you need the detail.

## Script API reference

Globals available in every sandboxed script:

```javascript
// Pages (all in the same shared profile/session)
browser.getPage(nameOrTargetId)  // named page (persists across runs) OR attach an existing tab by id
browser.newPage()                // anonymous tab, cleaned up when the script exits
browser.listPages()              // [{ id, url, title, name }] — every tab in the profile
browser.closePage(name)          // close a named page you created

// File I/O — async, restricted to ~/.dev-browser/tmp/ (no filesystem escape)
await saveScreenshot(buffer, name)   // returns absolute path
await writeFile(name, data)          // returns absolute path
await readFile(name)                 // returns file contents as a string

// Output
console.log / info      // -> CLI stdout
console.warn / error    // -> CLI stderr
console.json(value)     // -> exactly one JSON line on stdout
```

Pages are full Playwright `Page` objects: `goto`, `click`, `fill`, `locator`, `getByRole`, `evaluate`, `waitForSelector`, `waitForURL`, `screenshot`, `$$eval`, and the rest. Two reliable habits:

- On local dev servers (Next.js, Vite, ...), navigate with `page.goto(url, { waitUntil: "domcontentloaded" })`. The default `"load"` can hang on HMR or streaming connections.
- Inside `page.evaluate(...)`, write **plain JavaScript only** — the browser context has no TypeScript and no sandbox globals.

## Discovery and diagnostics — the authoritative contract

This SKILL.md is the mental model and the *why*. The exhaustive, versioned, machine-readable contract lives in the CLI itself — consult it rather than guessing flags or memorizing grammar that may have changed:

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
