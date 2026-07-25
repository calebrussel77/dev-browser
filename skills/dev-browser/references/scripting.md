# Sandboxed scripts

Raw Playwright power inside a locked-down QuickJS WASM runtime. Best when you know the page and the selectors: bulk DOM extraction, `page.evaluate`, precise locators, custom loops.

```bash
dev-browser --connect <<'EOF'
const page = await browser.getPage("main");
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
console.json({ title: await page.title(), url: page.url() });
EOF
```

You can also run a file: `dev-browser run file.js`.

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

## Sandbox limits

The sandbox is **not** Node.js. There is no `require`, `import`, `fetch`, `process`, `fs`, or `path`. File I/O is limited to the three helpers above, writing under `~/.dev-browser/tmp/`. A script that reaches for Node APIs fails, and the reported line number is often off by a bit, so recognize the cause rather than trusting the trace.

## Script-only helpers

- **`console.json(value)`** emits exactly one bounded, parseable JSON line (via the sandbox's own `JSON.stringify`, rejecting circular refs and oversized >64 KiB values cleanly). Prefer it over `console.log(JSON.stringify(...))` whenever a caller must parse one line.
- **`page.snapshotForAI({ track?, depth?, timeout? })`** returns `{ full, incremental? }`, an AI-optimized structural snapshot for element discovery on unknown pages.
