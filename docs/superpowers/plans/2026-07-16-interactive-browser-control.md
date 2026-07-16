# Interactive Browser Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a persistent perception-action loop to `dev-browser` with screenshots, trusted input, stable element refs, coordinates, landmarks, and confirmation guards while preserving the existing script mode.

**Architecture:** Add a typed `interactive` daemon request whose actions operate directly on Playwright `Page` objects managed by the existing `BrowserManager`. The Rust CLI exposes small subcommands that send these structured actions through the current socket protocol; the daemon returns JSON containing page state and optional screenshot paths under `~/.dev-browser/tmp`.

**Tech Stack:** Rust 2021 with clap/serde_json, Node.js TypeScript, Playwright 1.61.1, Zod, Vitest.

## Global Constraints

- Preserve stdin and `run` QuickJS script compatibility.
- Preserve browser and named-page state across CLI invocations.
- Use Playwright mouse, keyboard, and locator APIs for input; never call `HTMLElement.click()`.
- Never close or mutate unrelated existing tabs.
- Store screenshots only through the controlled `~/.dev-browser/tmp` writer.
- Treat refs as stable only while their annotated DOM element remains alive; require a new `read` after rerenders.
- Keep irreversible-action confirmation explicit and machine-verifiable.

---

### Task 1: Interactive protocol

**Files:**
- Modify: `daemon/src/protocol.ts`
- Create: `daemon/src/protocol.test.ts`

**Interfaces:**
- Produces: `InteractiveRequest` with browser connection options, optional page name/target ID, optional screenshot filename, and a discriminated `action`.
- Produces actions: `pages`, `navigate`, `read`, `find`, `click`, `type`, `confirm`, and `shot`.

- [x] **Step 1: Write failing parser tests**

Cover a valid `read`, a mouse click by ref, a coordinate click, typed text, and rejection of a click with neither ref nor coordinates.

```ts
expect(parseRequest(JSON.stringify({
  id: "interactive-1",
  type: "interactive",
  browser: "default",
  page: "main",
  action: { kind: "click", ref: "R12", method: "mouse" },
}))).toMatchObject({ success: true });
```

- [x] **Step 2: Verify the focused test fails**

Run: `cd daemon && pnpm vitest run src/protocol.test.ts`

Expected: FAIL because the interactive schema is absent.

- [x] **Step 3: Add the request schemas and exported type**

Use a Zod discriminated union with these payloads:

```ts
type InteractiveAction =
  | { kind: "pages" }
  | { kind: "navigate"; url: string }
  | { kind: "read"; limit: number; depth: number }
  | { kind: "find"; query: string; limit: number }
  | { kind: "click"; ref?: string; x?: number; y?: number; method: "mouse" | "locator"; expectText?: string }
  | { kind: "type"; ref?: string; text: string; clear: boolean; delayMs: number }
  | { kind: "confirm"; expectText?: string }
  | { kind: "shot" };
```

The request reuses `browser`, `connect`, `headless`, `ignoreHTTPSErrors`, and `timeoutMs` from execute requests. Require `page` for every action except `pages`.

- [x] **Step 4: Run the focused tests**

Run: `cd daemon && pnpm vitest run src/protocol.test.ts`

Expected: PASS.

---

### Task 2: Playwright interactive action engine

**Files:**
- Create: `daemon/src/interactive-actions.ts`
- Create: `daemon/src/interactive-actions.test.ts`

**Interfaces:**
- Consumes: `BrowserManager`, browser name, `InteractiveRequest`.
- Produces: `executeInteractiveAction(manager, request): Promise<InteractiveResult>`.
- Produces element records `{ ref, role, name, landmark, visible, box: { x, y, width, height } }`.

- [x] **Step 1: Write failing end-to-end action tests**

Launch a headless managed browser containing a main profile card and an aside with duplicate button names. Verify:

```ts
expect(result.elements).toEqual(expect.arrayContaining([
  expect.objectContaining({ name: "Connect", landmark: expect.stringContaining("main") }),
  expect.objectContaining({ name: "Connect", landmark: expect.stringContaining("aside") }),
]));
```

Also verify refs persist between reads, `find` ranks the main-card button, mouse click fires a trusted `PointerEvent`, keyboard typing updates a contenteditable, screenshots exist, and confirmation rejects the wrong recipient text.

- [x] **Step 2: Verify the focused tests fail**

Run: `cd daemon && pnpm vitest run src/interactive-actions.test.ts`

Expected: FAIL because the action engine is absent.

- [x] **Step 3: Implement DOM annotation and page perception**

Annotate interactive elements with `data-dev-browser-ref="R<number>"`. Preserve existing refs and store the next counter on `window`. Inspect:

```ts
"a[href],button,input,textarea,select,[role],[contenteditable=true],[tabindex]:not([tabindex='-1'])"
```

Derive accessible names from `aria-label`, associated labels, text, alt, title, placeholder, and value. Walk ancestors for `main`, `aside`, `nav`, `header`, `footer`, dialog roles, IDs, and stable class names. Return viewport-relative bounding boxes and visibility. Pair the element list with `page.locator("body").ariaSnapshot()`.

- [x] **Step 4: Implement query ranking**

Normalize case and diacritics, remove common French/English stopwords, and score query tokens against role, name, landmark, and visibility. Exact name and landmark matches receive higher weights. Return the highest-scoring records with coordinates.

- [x] **Step 5: Implement trusted actions and guardrails**

- Mouse ref click: resolve the ref, read its bounding box, call `page.mouse.click(centerX, centerY)`.
- Locator ref click: call `locator.click({ timeout })`.
- Coordinate click: call `page.mouse.click(x, y)`.
- Type: focus a ref through a real mouse click, optionally press `ControlOrMeta+A` and `Backspace`, then call `page.keyboard.type(text, { delay })`.
- Confirm: return visible dialog text, or visible body text when no dialog exists.
- Guarded click: before input, normalize current dialog/body text and require `expectText` to be present.
- Screenshot: call `page.screenshot()` and `writeDevBrowserTempFile()`; return the absolute path.

- [x] **Step 6: Run the action tests**

Run: `cd daemon && pnpm vitest run src/interactive-actions.test.ts`

Expected: PASS.

---

### Task 3: Daemon request handling

**Files:**
- Modify: `daemon/src/daemon.ts`
- Modify: `daemon/src/protocol.test.ts`

**Interfaces:**
- Consumes: `InteractiveRequest`, `executeInteractiveAction()`.
- Produces: one `result` response followed by `complete`, or a structured `error`.

- [x] **Step 1: Add a shared browser preparation helper**

Extract the existing connect/ensure logic used by `handleExecute` into:

```ts
async function prepareBrowser(request: {
  browser: string;
  connect?: string;
  headless?: boolean;
  ignoreHTTPSErrors?: boolean;
  timeoutMs?: number;
}): Promise<number>;
```

Return the effective timeout so script and interactive handlers use identical connection behavior.

- [x] **Step 2: Add `handleInteractive`**

Run it under `withBrowserLock(request.browser)`, prepare the browser, execute the action, and write the result and completion messages.

- [x] **Step 3: Route the request and run focused tests**

Run: `cd daemon && pnpm vitest run src/protocol.test.ts src/interactive-actions.test.ts`

Expected: PASS.

---

### Task 4: Rust interactive subcommands

**Files:**
- Create: `cli/src/interactive.rs`
- Modify: `cli/src/main.rs`

**Interfaces:**
- Produces commands: `pages`, `navigate`, `read`, `find`, `click`, `type`, `confirm`, `shot`.
- Produces JSON daemon requests through `build_interactive_request()`.

- [x] **Step 1: Write failing Rust parsing/request tests**

Test `Cli::try_parse_from` and JSON generation for:

```text
dev-browser --connect read --page TARGET --shot state.png
dev-browser --connect find "connect main profile" --page TARGET
dev-browser --connect click --ref R12 --page TARGET --expect-text Naminsita
dev-browser --connect click --xy 901,631 --page TARGET
dev-browser --connect type --ref R13 --text hello --clear --page TARGET
```

- [x] **Step 2: Verify Rust tests fail**

Run: `cd cli && cargo +stable-x86_64-pc-windows-msvc test`

Expected: FAIL because the subcommands do not exist.

- [x] **Step 3: Implement reusable CLI argument structs**

Use clap `Args` for page selection and optional screenshots. `--shot` accepts an optional filename with `interactive-<timestamp>.png` as the daemon default. Parse `--xy` as two finite non-negative numbers. Require exactly one of `--ref` or `--xy` for click.

- [x] **Step 4: Send interactive requests**

Reuse `ensure_daemon`, connection flags, timeouts, and `send_request(..., ResultMode::Json)`. Keep stdin and `run` dispatch unchanged.

- [x] **Step 5: Run Rust tests and command help checks**

Run:

```powershell
cd cli
cargo +stable-x86_64-pc-windows-msvc test
cargo +stable-x86_64-pc-windows-msvc run -- read --help
cargo +stable-x86_64-pc-windows-msvc run -- click --help
```

Expected: all commands exit 0 and document refs, coordinates, trusted input, screenshots, and confirmation guards.

---

### Task 5: Agent-facing documentation and live loop

**Files:**
- Modify: `cli/llm-guide.txt`
- Modify: `README.md`

**Interfaces:**
- Consumes: all interactive subcommands.
- Produces: a copy/paste perception-action-perception workflow for PowerShell and POSIX shells.

- [x] **Step 1: Document the safe loop**

Document this sequence using a persistent page or target ID:

```powershell
dev-browser --connect pages
dev-browser --connect read --page TARGET --shot before.png
dev-browser --connect find "connect main profile" --page TARGET
dev-browser --connect click --page TARGET --ref R12 --shot modal.png
dev-browser --connect confirm --page TARGET --expect "Naminsita Bakayoko" --shot confirm.png
dev-browser --connect type --page TARGET --ref R13 --text "Message" --clear --shot typed.png
dev-browser --connect click --page TARGET --ref R14 --expect-text "Naminsita Bakayoko" --shot sent.png
```

Tell agents to open every returned screenshot path with their image-viewing tool before the next consequential action. Explain that refs survive ordinary calls but must be refreshed after rerenders.

- [x] **Step 2: Run full validation and rebuild embedded assets**

Run:

```powershell
cd daemon
npx tsc --noEmit
pnpm vitest run
pnpm bundle
pnpm bundle:sandbox-client
cd ../cli
cargo +stable-x86_64-pc-windows-msvc build
```

Expected: all commands exit 0.

- [x] **Step 3: Exercise the compiled CLI against a deterministic page**

Use a local or data-URL page with duplicate button names in `main` and `aside`. Verify `read`, `find`, trusted `click`, trusted `type`, `confirm`, `--shot`, and state persistence across separate CLI invocations.

- [x] **Step 4: Inspect the screenshots visually**

Open the PNG returned before and after actions. Verify the correct main-card element was activated and the typed text is visible.

- [x] **Step 5: Review the final worktree**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only intended implementation, tests, plan, and documentation changes.
