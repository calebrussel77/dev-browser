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
