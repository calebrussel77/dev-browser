<p align="center">
  <img src="assets/header.png" alt="Dev Browser - Browser automation for Claude Code" width="100%">
</p>

Brought to you by [Do Browser](https://dobrowser.io).

A browser automation tool that lets AI agents and developers control browsers with sandboxed JavaScript scripts.

**Key features:**

- **Sandboxed execution** - Scripts run in a QuickJS WASM sandbox with no host access
- **Persistent pages** - Navigate once, interact across multiple scripts
- **Auto-connect** - Connect to your running Chrome or launch a fresh Chromium
- **Full Playwright API** - goto, click, fill, locators, evaluate, screenshots, and more
- **Interactive agent loop** - Read refs and landmarks, inspect screenshots, then click and type with trusted input one action at a time

## Demo

https://github.com/user-attachments/assets/c6cf7fb9-b1dc-46ed-93b9-6e7240990c53

## CLI Installation

```bash
npm install -g @calebrussel77/dev-browser
dev-browser install    # installs Playwright + Chromium
```

### Quick start

```bash
# Launch a headless browser and run a script
dev-browser --headless <<'EOF'
const page = await browser.getPage("main");
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
console.log(await page.title());
EOF

# Connect to your running Chrome (enable at chrome://inspect/#remote-debugging)
dev-browser --connect <<'EOF'
const tabs = await browser.listPages();
console.log(JSON.stringify(tabs, null, 2));
EOF
```

### Interactive visual control

For consequential UI work, prefer the persistent interactive commands over a monolithic script. They return structured JSON, and `--shot` writes a PNG under `~/.dev-browser/tmp` and returns its absolute path.

```powershell
# Discover existing tabs without attaching every renderer
dev-browser --connect pages

# Perceive: compact protocol-v2 state, refs, frames, open shadow roots, and coordinates
dev-browser --connect observe --page TARGET_ID --annotate --shot before.png

# Find the correct duplicate label deterministically; natural queries remain supported
dev-browser --connect find --page TARGET_ID --role button --name "Connect" --name-mode exact --within main --near "Profile" --scope document

# Act through a trusted Playwright mouse event and wait for the expected UI
dev-browser --connect click --page TARGET_ID --ref R12 --from-state doc-7:184 --wait-text "visible,body,contains,Add a note" --shot modal.png

# Verify the recipient before the final irreversible action
dev-browser --connect confirm --page TARGET_ID --ref F0:R14 --expect "Naminsita Bakayoko" --shot confirm.png

# Focus and type through trusted mouse + keyboard input
dev-browser --connect type --page TARGET_ID --ref R13 --text "Invitation note" --clear --shot typed.png

# The final click is blocked unless the current dialog still contains the expected recipient
dev-browser --connect click --page TARGET_ID --ref F0:R14 --from-state doc-7:190 --confirm-token TOKEN --shot sent.png

# Persist bounded diagnostics only when needed
dev-browser --connect click --page TARGET_ID --ref R12 --trace
dev-browser trace show LAST

# Discover the installed contract and diagnose runtime/CDP health
dev-browser schema --json
dev-browser capabilities --compact
dev-browser doctor --connect --json
```

Protocol v2 confirmation tokens are daemon-scoped, expire after 30 seconds, bind to the observed page/document/target/URL, and are burned on the first consumption attempt. Results, typed errors, waits, journals, popup/download/network metadata, and diagnostics use the same bounded secret redactor. `--expect-text` remains available for protocol v1 compatibility.

An invalid, expired, reused, or out-of-scope confirmation token returns the stable `CONFIRMATION_INVALID` error and process exit status `8`.

Open each returned screenshot path with your agent's image-viewing capability before the next consequential action. `observe` is the canonical compact perception command; `read` remains compatible. `find` always takes a fresh snapshot and accepts either the compatible natural query or combinable `--role`, `--name`, `--name-mode`, `--within`, `--near`, `--frame`, `--scope`, repeated `--state`, and explicit last-resort `--index` filters. Results include exact match reasons, confidence, score gap, ambiguity, landmark, nearby context, frame, box, and actionability state. Actions return a refreshed state and reject stale refs/states, ambiguity, obstruction, disabled targets, and page-lease conflicts with stable errors and exit statuses. Typed waits cover text, URL, refs, dialogs, toasts, popups, downloads, file choosers, navigation, responses, failed requests, and specialized network idle. Safe retries require evidence that the prior attempt produced no side effect; guarded or irreversible actions are never duplicated. Screenshot pixels, ref boxes, frame offsets, and direct `--xy X,Y` all use CSS pixels, including non-zero scroll and DPR greater than one.

The CLI and daemon negotiate version, bundle, protocol, Playwright, and QuickJS provenance before each request. An idle mismatched daemon is restarted automatically; in-flight work is never killed silently. `doctor --json` distinguishes daemon, browser/CDP, and renderer failures and provides recovery codes. `--trace` stores a redacted, size-bounded journal under `~/.dev-browser/tmp/traces` with timing, before/after state, target/input method, requested screenshots, errors, network/lifecycle events, waits, retries, and recovery hints. Twenty recent traces are retained. External CDP traces are best-effort and report that limitation.

### Video recording

Record a page to a playable WebM file — a QA journey, proof of work, or a demo. The recording lives in the daemon, so ordinary commands interleave between the video ones.

```powershell
dev-browser --connect video start recordings/login-flow.webm --page TARGET_ID --size 1280x800
dev-browser --connect video chapter "Sign in" --page TARGET_ID --description "Entering credentials" --duration 2000
dev-browser --connect click --page TARGET_ID --ref R12
dev-browser --connect video stop --page TARGET_ID
```

`video start` and `video stop` both return the absolute `.webm` path. Without a file argument the recording lands under `~/.dev-browser/tmp/videos`; a relative path resolves against your working directory. One active recording per page; distinct pages record in parallel. Every recording carries a max duration (default 600 seconds, `--max-duration SECONDS`) after which the daemon finalizes the file itself, and recordings are finalized gracefully on page close, browser stop, and daemon shutdown. Sandboxed scripts get the full `page.screencast` API — `start({ path, size })`, `showChapter()`, `showOverlay()` with disposables, `hideOverlays()`/`showOverlays()`, `stop()` — for paced hero videos with annotations. Popups and new tabs are not captured, and a covered connected-Chrome window freezes the picture.

### Bounded screenshots

Every capture — `shot`, `observe --shot`, and action screenshots — has a hard deadline: `--shot-timeout MILLISECONDS` (`250..120000`, default `min(--timeout, 8000)`). Capture prefers a single CDP `Page.captureScreenshot` call so it never waits on perpetual CSS/Web animations, blinking carets, or `document.fonts.ready`; animations and the caret are hidden for the duration of the capture and the injected style is always removed afterward, even on failure. Playwright's own `page.screenshot()` is used only as a one-time fallback when CDP capture is unavailable, and never after a CDP deadline has already elapsed. Result metadata reports `captureMode: "cdp" | "playwright"` so callers can tell which path produced the artifact.

```powershell
dev-browser --connect shot --page TARGET_ID --shot-timeout 4000 spinner.png
```

### Scoped observation, subtree text, and assertions

`observe`, `text`, and `assert` share the same scope grammar as `find`'s `--within`: a landmark substring (`main`, `aside`, `dialog`), `role:<role>`, or `name:<exact accessible name>`. Scoping keeps node/character/depth/breadth budgets focused on the relevant subtree instead of being spent on repeated chrome (headers, sidebars, nav) outside it.

```powershell
# Perceive only the main region instead of spending the node budget on chrome around it
dev-browser --connect observe --page TARGET_ID --within main --max-nodes 300

# Read bounded, normalized text (line breaks preserved) from a ref or a scope
dev-browser --connect text --page TARGET_ID --ref R42
dev-browser --connect text --page TARGET_ID --within main

# Fail fast, with no trusted-input attempt, if expected text is not present
dev-browser --connect assert --page TARGET_ID --within main --text "Jane Doe" --match contains
```

`observe --root REF` scopes to the subtree under a specific ref instead of a landmark (mutually exclusive with `--within`); `observe --text-only` returns bounded normalized `innerText` with truncation metadata instead of the full element tree. `assert` returns `{ asserted: true, scope, observed }` on success; on failure it returns the typed, recoverable `ASSERTION_FAILED` error (exit status `3`) and makes no trusted-input attempt.

### Virtualized / infinite-scroll containers

Rows recycled by a virtualized list (only a handful of DOM nodes exist for dozens or hundreds of logical items) are invisible to a single snapshot. `scroll --ref CONTAINER --until ...` and `find --scroll-container CONTAINER --max-steps N` scroll the container itself (positioning the mouse over it and issuing a trusted wheel event, not `window`/`element.scrollIntoView`) and re-collect scoped perception after every step:

```powershell
# Container-relative scroll until a specific row's text appears
dev-browser --connect scroll --page TARGET_ID --ref R2 --until "text:Conversation 47" --max-steps 20

# Bounded auto-scroll find: fresh find -> one container scroll -> fresh find, repeated until confident,
# exhausted, or --max-steps is reached. Never auto-clicks the result.
dev-browser --connect find --page TARGET_ID --name "Conversation 47" --scroll-container R2 --max-steps 20
```

The result includes `scrollMetrics: { steps, uniqueItems, newItems, exhausted, positions[] }` so callers can tell a genuinely short list from one that stopped discovering new rows for another reason.

### React-safe exact text entry

`type` inspects the resolved ref's kind and enters text the way the corresponding DOM API expects instead of relying on `HTMLElement.click()` + naive keystrokes alone:

- `input`/`textarea`: invokes the element's native value setter, then dispatches composed, bubbling `beforeinput`, `input`, and `change` events — the same sequence a real keystroke produces, so React (and similar) controlled components observe and commit the change.
- `contenteditable`: focuses the element and uses `page.keyboard.insertText(text)` (after select-all/backspace when `--clear` is set). Rich-text editors (Draft.js / Lexical-style, e.g. LinkedIn's message composer) that manage their own model and drop a bulk `insertText` are handled by an automatic fall back to real key-by-key typing, which they commit. Verification is newline-normalized, so an editor that renders a typed newline as a paragraph break still verifies as an exact match.

The result reports `{ typed, inputStrategy, verifiedValue }`, where `inputStrategy` is `native-setter`, `insert-text`, or `keyboard`. After entry, dev-browser rereads the field's `value`/`innerText`; if it does not match what was requested (a validating/normalizing field rewrote it, or the controlled component never re-rendered), the action returns the typed, recoverable `INPUT_VALUE_MISMATCH` error (exit status `3`) instead of reporting success. `--clear false` (the default) appends at the existing caret/end of the field rather than replacing its contents.

```powershell
dev-browser --connect type --page TARGET_ID --ref R13 --text "Exact message, multiple\nlines" --clear
```

### Error codes

All actionability, assertion, and input-verification failures share the exit-status-`3` family and are typed and recoverable (no partial or ambiguous side effect):

| Code | Meaning |
| --- | --- |
| `STALE_REF` / `STALE_STATE` | The ref or `--from-state` no longer matches the live DOM/document. |
| `AMBIGUOUS_TARGET` | A scope or filter (`--within`, `--role`, `--name`, ...) matched more than one element. |
| `TARGET_MISSING` / `TARGET_HIDDEN` / `TARGET_OBSCURED` | The resolved element does not exist, is not visible, or is covered by another element. |
| `TARGET_DISABLED` | The resolved element is currently disabled (e.g. a send button gated on composer state). |
| `ASSERTION_FAILED` | `assert`'s expected text was not found in the resolved scope. |
| `INPUT_VALUE_MISMATCH` | The reread value/`innerText` after `type` did not match the requested text. |

`WAIT_TIMEOUT` (exit `4`), `LEASE_CONFLICT` (exit `5`), and `CONFIRMATION_INVALID` (exit `8`) remain their own families. The full set, with process exit statuses, is in `dev-browser schema --json`.

### Safe recipient / send-availability recipes

These two patterns are site-agnostic (no LinkedIn or other site-specific selectors) and cover the most common "did this actually work" failure modes for messaging-style UIs:

**Detect an unavailable send button before attempting to click it:**

```powershell
# find --state disabled surfaces the button as currently disabled...
dev-browser --connect find --page TARGET_ID --role button --name "Send" --state disabled

# ...and clicking a disabled target returns the typed TARGET_DISABLED error (exit 3)
# instead of silently no-opping or reporting a false success.
dev-browser --connect click --page TARGET_ID --ref R9
```

**Verify a thread actually opened before composing a message:** a deep link into a single-page app's conversation view may resolve the URL without the panel having hydrated yet. Do a real click, then assert on the resulting URL or header text rather than trusting the click alone:

```powershell
# 1. A real click (not a direct navigation) opens the thread the same way a user would.
dev-browser --connect click --page TARGET_ID --ref R14 --wait-url "contains,/thread/"

# 2. Confirm the thread that actually rendered is the expected one before typing into it.
dev-browser --connect assert --page TARGET_ID --within main --text "Jane Doe" --match contains

# 3. Only now is it safe to type/confirm/send.
dev-browser --connect type --page TARGET_ID --ref R13 --text "Hello" --clear
```

### `console.json` for scripted output

Inside a piped script, `console.json(value)` emits `value` as exactly one bounded, parseable JSON line (via the sandbox's own `JSON.stringify`, so it correctly rejects circular references instead of hanging or crashing). Oversized values (over 64 KiB serialized) are also rejected with a short, bounded diagnostic rather than being emitted partially or truncated mid-structure:

```javascript
console.json({ ok: true, count: 3 }); // stdout: {"ok":true,"count":3}
```

Prefer `console.json` over `console.log(JSON.stringify(...))` when structured output must be exactly one line for a caller to parse.

### Local, non-destructive reliability fixture (T1-T5)

The daemon test suite includes `daemon/src/test-fixtures/agent-reliability-fixture.ts`, a fully local (`127.0.0.1`) fixture with no external network access, used to reproduce LinkedIn/Sales-Navigator-shaped reliability problems without ever touching a real site or account. It is exercised by the daemon's own Vitest suite (`agent-reliability-fixture.test.ts`, `visual-artifacts.test.ts`, `scoped-content.test.ts`, `actions/primitives.test.ts`, `react-input.test.ts`, and others) and, once started under Node, is drivable with the same CLI commands documented above — for example:

```powershell
dev-browser --connect shot --page TARGET_ID --shot-timeout 4000 t1-shot.png
dev-browser --connect observe --page TARGET_ID --within main --max-nodes 300
dev-browser --connect find --page TARGET_ID --name "Conversation 47" --scroll-container R2 --max-steps 20
dev-browser --connect click --page TARGET_ID --ref R14 --wait-url "contains,/thread/"
dev-browser --connect assert --page TARGET_ID --within main --text "Jane Doe" --match contains
dev-browser --connect type --page TARGET_ID --ref R13 --text "Exact message" --clear
```

No command in this workflow sends a real message, invitation, or connection request; the fixture never talks to a real site.

### PowerShell (Windows)

```powershell
@"
const page = await browser.getPage("main");
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
console.log(await page.title());
"@ | dev-browser
```

With `--connect`:

```powershell
@"
const page = await browser.getPage("main");
console.log(await page.title());
"@ | dev-browser --connect
```

### Windows notes

PowerShell install:

```powershell
# GitHub latest installer, Windows x64
irm https://github.com/calebrussel77/dev-browser/releases/latest/download/install-windows.ps1 | iex
dev-browser install

# Or npm latest, once the scoped package has been published
npm install -g @calebrussel77/dev-browser
dev-browser install
```

To attach to a running Chrome instance on Windows:

```powershell
chrome.exe --remote-debugging-port=9222
dev-browser --connect
```

Windows npm installs download the native `dev-browser-windows-x64.exe` release asset during `postinstall`, and the generated npm shims invoke that executable directly.

### Using with AI agents

After installing, tell your agent to run `dev-browser --help` for the concise command map. The authoritative contract is `dev-browser schema --json`; use `capabilities --compact` for fast discovery and `examples COMMAND` for a focused recipe. No plugin or skill installation is required.

<details>
<summary>Allowing dev-browser in Claude Code without permission prompts</summary>

By default, Claude Code asks for approval each time it runs a bash command. You can pre-approve `dev-browser` so it runs without permission checks by adding it to the `allow` list in your settings.

**Per-project** — add to `.claude/settings.json` in your project root:

```json
{
  "permissions": {
    "allow": [
      "Bash(dev-browser *)"
    ]
  }
}
```

**Per-user (global)** — add to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(dev-browser *)"
    ]
  }
}
```

The pattern `Bash(dev-browser *)` matches any command starting with `dev-browser ` followed by arguments (e.g. `dev-browser --headless`, `dev-browser --connect`). This is safe because dev-browser scripts run in a sandboxed QuickJS WASM environment with no host filesystem or network access.

You can also allow related commands in the same list:

```json
{
  "permissions": {
    "allow": [
      "Bash(dev-browser *)",
      "Bash(npx @calebrussel77/dev-browser *)"
    ]
  }
}
```

> **Tip:** If you've already been prompted and clicked "Always allow", Claude Code adds the specific command pattern automatically. The settings file approach lets you pre-approve it before the first run.

</details>

<details>
<summary>Legacy plugin installation (Claude Code / Amp / Codex)</summary>

### Claude Code

```
/plugin marketplace add calebrussel77/dev-browser
/plugin install dev-browser@calebrussel77/dev-browser
```

Restart Claude Code after installation.

### Amp / Codex

Copy the skill to your skills directory:

```bash
# For Amp: ~/.claude/skills | For Codex: ~/.codex/skills
SKILLS_DIR=~/.claude/skills  # or ~/.codex/skills

mkdir -p $SKILLS_DIR
git clone https://github.com/calebrussel77/dev-browser /tmp/dev-browser-skill
cp -r /tmp/dev-browser-skill/skills/dev-browser $SKILLS_DIR/dev-browser
rm -rf /tmp/dev-browser-skill
```

</details>

## Script API

Scripts run in a sandboxed QuickJS runtime (not Node.js). Available globals:

```javascript
// Browser control
browser.getPage(nameOrId)    // Get/create named page, or connect to tab by targetId
browser.newPage()            // Create anonymous page (cleaned up after script)
browser.listPages()          // List all tabs: [{id, url, title, name}]
browser.closePage(name)      // Close a named page

// File I/O (restricted to ~/.dev-browser/tmp/)
await saveScreenshot(buf, name)   // Save screenshot buffer, returns path
await writeFile(name, data)       // Write file, returns path
await readFile(name)              // Read file, returns content

// Output
console.log/warn/error/info       // Routed to CLI stdout/stderr
```

Pages are full [Playwright Page objects](https://playwright.dev/docs/api/class-page) — `goto`, `click`, `fill`, `locator`, `evaluate`, `screenshot`, and everything else, including `page.snapshotForAI({ track?, depth?, timeout? })`, which returns `{ full, incremental? }` for AI-friendly page snapshots.

## Benchmarks

| Method                  | Time    | Cost  | Turns | Success |
| ----------------------- | ------- | ----- | ----- | ------- |
| **Dev Browser**         | 3m 53s  | $0.88 | 29    | 100%    |
| Playwright MCP          | 4m 31s  | $1.45 | 51    | 100%    |
| Playwright Skill        | 8m 07s  | $1.45 | 38    | 67%     |
| Claude Chrome Extension | 12m 54s | $2.81 | 80    | 100%    |

_See [dev-browser-eval](https://github.com/SawyerHood/dev-browser-eval) for methodology._

## License

MIT

## Author

[Sawyer Hood](https://github.com/sawyerhood)
