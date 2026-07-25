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

## The three decisions, in order

**1. Which browser to drive.** Pick from the *task*, not by habit.

| You want... | Use |
| --- | --- |
| The user's real Chrome, with their logins, cookies, and open tabs | `dev-browser --connect` |
| A specific CDP endpoint you were handed | `dev-browser --connect http://localhost:9222` |
| A clean, isolated, *persistent* automation profile | `dev-browser --browser <task-name>` |
| Disposable unattended automation | `dev-browser --browser <name> --headless` |

**2. Which tab(s).** One browser = one profile = one cookie jar = one authenticated session, and every tab in it shares that session. Address a tab by a **name you choose** (`--page feed`, persists across runs) or by an **existing target id** from `pages`. Driving several tabs of one logged-in profile at once is the core strength.

**3. Scripts or interactive commands.** **Known page and selectors → script; unknown or high-stakes UI → interactive loop.** You can mix them freely on the same page.

Full detail: `references/browsers-and-pages.md` for decisions 1 and 2.

## The interactive perception-action loop

The loop is: **perceive → find → act → verify**, one step per command, opening any returned screenshot before the next consequential action.

```bash
dev-browser --connect pages                                   # 1. discover tabs
dev-browser --connect observe --page TARGET --annotate --shot before.png   # 2. perceive: refs + coords
dev-browser --connect find --page TARGET --role button --name "Connect" --name-mode exact --within main   # 3. pick the exact element
dev-browser --connect click --page TARGET --ref R12 --from-state doc-7:184 --wait-text "visible,body,contains,Add a note"   # 4. act + wait
dev-browser --connect confirm --page TARGET --ref F0:R14 --expect "Jane Doe"   # 5. verify recipient before an irreversible click
dev-browser --connect click --page TARGET --ref F0:R14 --from-state doc-7:190 --confirm-token TOKEN   # 6. final guarded action
```

Refs are `R#` or `F#:R#` (framed); page state ids are `doc-#:revision`. **Refs and states go stale** when the DOM rerenders — re-`observe`/`find` and use the fresh values rather than reusing old ones. All coordinates (screenshot pixels, ref boxes, `--xy`) are **CSS pixels**, regardless of device pixel ratio or scroll.

Full detail — every command group, the safety features, the error/exit-status table, and the features that solve specific painful problems (React-safe `type`, virtualized containers, bounded screenshots, `--trace`): `references/interactive-loop.md`.

## Sandboxed scripts

Pipe JavaScript over stdin (or `dev-browser run file.js`). Every page is a full [Playwright `Page`](https://playwright.dev/docs/api/class-page).

```bash
dev-browser --connect <<'EOF'
const page = await browser.getPage("main");
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
console.json({ title: await page.title(), url: page.url() });
EOF
```

Full detail — the script globals, file I/O helpers, `console.json`, `snapshotForAI`, and the sandbox's hard limits: `references/scripting.md`.

## Discovery and diagnostics — the authoritative contract

This SKILL.md is the mental model and the *why*. The exhaustive, versioned, machine-readable contract lives in the CLI itself — consult it rather than guessing flags or memorizing grammar that may have changed:

```bash
dev-browser --help                 # concise command + flag map
dev-browser schema --json          # AUTHORITATIVE: every command, action grammar, wait grammar, error codes, limits
dev-browser capabilities --compact # fast one-line feature discovery
dev-browser examples click         # a focused copy/paste recipe for one command
dev-browser doctor --connect --json  # diagnose CLI/daemon/browser/CDP health with typed recovery codes
```

Full detail — recovery playbook, lifecycle commands, the pitfalls checklist, and installation: `references/diagnostics-and-recovery.md`.

## References

| File | Read it when |
| --- | --- |
| `references/browsers-and-pages.md` | Choosing `--connect` vs. a managed profile, or working across several tabs of one session |
| `references/interactive-loop.md` | Running the perceive → find → act → verify loop, or decoding a typed error |
| `references/scripting.md` | Writing a sandboxed script, or hitting a sandbox limitation |
| `references/diagnostics-and-recovery.md` | Something is surprising, broken, or needs cleanup — plus install |
