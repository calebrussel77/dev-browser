# LinkedIn and Sales Navigator Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `dev-browser` reliably capture, scope, scan, type into, and safely act on heavy LinkedIn and Sales Navigator pages without LinkedIn-specific selectors in production code.

**Architecture:** Extend protocol v2 with generic screenshot, scoped perception, virtual-container, assertion, and React-safe input capabilities. Reproduce each production failure with deterministic local fixtures; keep all browser input trusted or native-setter-backed with explicit event verification, and preserve typed failures and bounded output.

**Tech Stack:** Rust/clap CLI, TypeScript Node daemon, Playwright 1.61.1, Chromium CDP, Vitest.

## Global Constraints

- Use Node.js and `pnpm` for `daemon/`; use Cargo MSVC for `cli/`; do not use Bun.
- Regenerate both daemon bundles before Cargo validation because the Rust binary embeds them.
- Keep protocol v1 compatibility and expose all new protocol-v2 fields in `schema --json` and `capabilities`.
- Production code must remain site-agnostic; LinkedIn/Sales Nav behavior is represented only by deterministic fixture structure.
- Screenshot completion must have a hard deadline and must not wait for perpetual CSS/Web animations or fonts.
- No acceptance test may send a real LinkedIn message or invitation.
- New typed error codes must be registered in `daemon_error_exit_code` in `cli/src/main.rs` and in its `maps_typed_agent_errors_to_stable_exit_codes` test; reuse the existing exit-3 family (`STALE_REF`, `AMBIGUOUS_TARGET`, `TARGET_DISABLED`) for target/state failures.

## Starting State (2026-07-17)

The working tree on `calebrussel77/fix-linkedin-sales-nav-reliability` already contains an **uncommitted, near-complete implementation of Task 1** (CDP-first bounded capture in `daemon/src/visual-artifacts.ts`, `shotTimeoutMs` in `daemon/src/protocol.ts`, `--shot-timeout` wiring in `cli/src/main.rs` and `cli/src/interactive.rs`, plus tests in `daemon/src/visual-artifacts.test.ts` and `daemon/src/protocol.test.ts`). Task 1's implementer must review and complete this existing diff against the task contract — not rewrite it or start from a clean tree. In particular, verify:

- the focused tests actually pass (they have not been run yet);
- `build_interactive_request` currently emits `shotTimeoutMs` unconditionally — confirm this does not break protocol v1 requests, or gate the field;
- the injected stability style is removed in `finally` on every path.

All other tasks start from committed state.

---

### Task 1: Bounded immediate screenshots

**Files:**
- Modify: `daemon/src/visual-artifacts.ts`
- Modify: `daemon/src/visual-artifacts.test.ts`
- Modify: `daemon/src/interactive-actions.ts`
- Modify: `daemon/src/protocol.ts`
- Modify: `daemon/src/protocol.test.ts`
- Modify: `cli/src/main.rs`
- Modify: `cli/src/interactive.rs`

**Interfaces:**
- Consumes: request-level `timeoutMs`, page coordinate space, optional crop/full-page mode.
- Produces: `captureVisualArtifacts(..., { timeoutMs, captureMode })`, CLI `--shot-timeout`, and artifact metadata `captureMode: "cdp" | "playwright"`.

> **Note:** most of this task already exists uncommitted in the working tree (see "Starting State"). Steps 1–4 become: audit the existing diff against this contract, fill any gap, and make the tests pass. Do not regenerate the work from scratch.

- [x] **Step 1: Write failing screenshot tests**

Add tests that monkeypatch `page.screenshot()` to never resolve while `page.context().newCDPSession(page).send("Page.captureScreenshot", ...)` returns a one-pixel PNG, and assert completion before the configured deadline. Add an animated fixture with infinite CSS animation, blinking caret, delayed `document.fonts.ready`, viewport capture, full-page capture, crop, and annotated capture.

- [x] **Step 2: Run the focused tests and verify failure**

Run: `cd daemon && pnpm vitest run src/visual-artifacts.test.ts src/protocol.test.ts`

Expected: failure because capture has no `timeoutMs`/`captureMode` contract and still calls Playwright screenshot directly.

- [x] **Step 3: Implement CDP-first bounded capture**

Use `context.newCDPSession(page)` and:

```ts
const response = await withDeadline(
  session.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: fullPage,
    clip: clip ? { ...clip, scale: 1 } : undefined,
  }),
  timeoutMs,
  "Screenshot capture"
);
return Buffer.from(response.data, "base64");
```

Disable animations and hide carets around capture through an injected style that is always removed in `finally`. Fall back once to Playwright with `{ animations: "disabled", caret: "hide", timeout: remainingMs }` only when CDP is unsupported, never after a CDP deadline.

- [x] **Step 4: Wire CLI and protocol limits**

Add `--shot-timeout <MILLISECONDS>` with range `250..120000`, defaulting to `min(global timeout, 8000)`, and pass it for `shot`, `observe --shot`, and action screenshots.

- [x] **Step 5: Run focused tests and commit**

Run: `cd daemon && pnpm vitest run src/visual-artifacts.test.ts src/protocol.test.ts && cd ../cli && cargo +stable-x86_64-pc-windows-msvc test`

Commit: `fix(screenshot): bound captures on animated pages`

### Task 2: Scoped observation, subtree text, and context assertions

**Files:**
- Modify: `daemon/src/protocol.ts`
- Modify: `daemon/src/perception/collector.ts`
- Modify: `daemon/src/perception/realm-collector.ts`
- Modify: `daemon/src/perception/tree.ts`
- Modify: `daemon/src/interactive-actions.ts`
- Create: `daemon/src/scoped-content.ts`
- Create: `daemon/src/scoped-content.test.ts`
- Modify: `cli/src/main.rs`
- Modify: `cli/src/interactive.rs`

**Interfaces:**
- Consumes: scope selector expressed as a stable `ref`, landmark/role, or exact accessible name.
- Produces: `observe { root?: string, within?: string, textOnly?: boolean }`, `text { ref|within }`, and `assert { ref|within, text, match }` with typed `ASSERTION_FAILED` exit 3.

- [x] **Step 1: Write failing scoped-content tests**

Build a fixture with more than 150 header/sidebar nodes before `main`, 40 named conversation rows, and a thread region containing messages attributed to `You` and `Prospect`. Assert that `observe --within main` returns the conversation rows without spending the node budget outside `main`; `text --ref` preserves multiline text; and `assert` fails without mutation when recipient text is absent.

- [x] **Step 2: Verify the tests fail**

Run: `cd daemon && pnpm vitest run src/scoped-content.test.ts src/perception/collector.test.ts`

Expected: protocol rejects the new actions/options.

- [x] **Step 3: Implement one bounded scope resolver**

Create `resolveContentScope(page, perception, { ref, within })` returning the frame/locator and stable scope metadata. Reuse ref resolution where possible; for `within`, accept `main`, `aside`, `dialog`, `role:<role>`, or `name:<exact name>` and reject multiple matches with the existing `AMBIGUOUS_TARGET` code.

The protocol already has a `within` option on `StructuredFindSchema` (`daemon/src/protocol.ts:271`) resolved in `daemon/src/targeting.ts`. `observe --within` must share that resolver and grammar — extract or call the existing resolution logic rather than introducing a second scope syntax. If the grammars cannot be unified in this task, the find grammar wins and this step extends it.

- [x] **Step 4: Apply the root before traversal**

Pass the resolved root into realm collection so max node/character/depth/breadth budgets apply only inside the selected subtree. For `textOnly`, return bounded normalized `innerText`, preserving line breaks and adding truncation metadata.

- [x] **Step 5: Add CLI commands and typed assertion**

Expose:

```text
dev-browser observe --within main --max-nodes 300
dev-browser text --ref R42
dev-browser assert --ref R7 --text "Jane Doe" --match contains
```

The assert result includes `{ asserted: true, scope, observed }`; failure includes `ASSERTION_FAILED`, `recoverable: true`, and no trusted input attempt. Register `ASSERTION_FAILED` in `daemon_error_exit_code` (`cli/src/main.rs`) mapping to exit 3, and extend the `maps_typed_agent_errors_to_stable_exit_codes` test with it.

- [x] **Step 6: Run focused tests and commit**

Run: `cd daemon && pnpm vitest run src/scoped-content.test.ts src/perception/collector.test.ts src/protocol.test.ts && cd ../cli && cargo +stable-x86_64-pc-windows-msvc test`

Commit: `feat(perception): scope observations and context assertions`

### Task 3: Virtualized container scanning and auto-scroll find

**Files:**
- Modify: `daemon/src/actions/primitives.ts`
- Modify: `daemon/src/actions/primitives.test.ts`
- Modify: `daemon/src/targeting.ts`
- Modify: `daemon/src/targeting.test.ts`
- Modify: `daemon/src/interactive-actions.ts`
- Modify: `daemon/src/protocol.ts`
- Modify: `daemon/src/test-fixtures/agent-reliability-fixture.ts`
- Modify: `daemon/src/test-fixtures/agent-reliability-fixture.test.ts`
- Modify: `cli/src/main.rs`

**Interfaces:**
- Consumes: `scrollContainer` stable ref, `maxSteps`, and existing `find` filters.
- Produces: container-relative `scroll --ref CONTAINER --until ...`, `find --scroll-container CONTAINER --max-steps N`, and discovery metrics `{ steps, uniqueItems, newItems, exhausted, positions[] }`.

- [x] **Step 1: Write a deterministic virtual-list fixture and failing tests**

Render exactly 12 of 60 conversation rows in a fixed-height overflow container, recycle DOM row nodes on scroll, and give each logical row a stable name. Tests must find row 47, enumerate at least 40 unique names without duplicates, and detect exhaustion when two consecutive steps add zero identities and scroll position no longer changes.

- [x] **Step 2: Verify the tests fail**

Run: `cd daemon && pnpm vitest run src/actions/primitives.test.ts src/targeting.test.ts src/test-fixtures/agent-reliability-fixture.test.ts`

Expected: scroll uses `window` and find cannot discover off-DOM rows.

- [x] **Step 3: Implement container-relative scrolling**

Resolve the container ref and evaluate its `scrollTop`, `scrollHeight`, and `clientHeight`. Scroll by one client height through trusted wheel input positioned over the container (`page.mouse.move` to the container's center, then `page.mouse.wheel`); fall back to locator evaluation only for reporting, not the user action. Extend the existing `scrollUntil` helper (`daemon/src/actions/primitives.ts:39`), which currently wheels without positioning the mouse, rather than adding a parallel scroll path. Recollect scoped perception after every step and track logical identity from test-id/href/role/name.

- [x] **Step 4: Implement bounded find auto-scroll**

Repeat fresh find → one container scroll → fresh find until a confident match, `maxSteps`, or exhaustion. Return all step metrics and never auto-click the result.

- [x] **Step 5: Run focused tests and commit**

Run: `cd daemon && pnpm vitest run src/actions/primitives.test.ts src/targeting.test.ts src/test-fixtures/agent-reliability-fixture.test.ts`

Commit: `feat(targeting): scan virtualized containers`

### Task 4: React-safe exact text entry

**Files:**
- Modify: `daemon/src/interactive-actions.ts`
- Modify: `daemon/src/interactive-actions.test.ts`
- Create: `daemon/src/react-input.ts`
- Create: `daemon/src/react-input.test.ts`
- Modify: `daemon/src/protocol.ts`
- Modify: `cli/src/main.rs`

**Interfaces:**
- Consumes: resolved input/textarea/contenteditable ref, exact Unicode text, clear and delay flags.
- Produces: type result `{ typed, inputStrategy, verifiedValue }`; strategy is `native-setter`, `insert-text`, or `keyboard`.

- [x] **Step 1: Write failing controlled-input tests**

Create React-like controlled input and textarea fixtures whose send button enables only after bubbling `beforeinput`/`input`, plus a contenteditable fixture. Test accented multiline text, replacement, empty text, and a 2,000-character message. Assert exact reread value and enabled send button.

Also add a disabled-composer case (T8): while the send button is still `disabled`, `click` on it must fail with the existing typed `TARGET_DISABLED` code instead of reporting success, and `find --states disabled` must surface the button. This covers unavailable-send detection locally.

- [x] **Step 2: Verify the tests fail**

Run: `cd daemon && pnpm vitest run src/react-input.test.ts src/interactive-actions.test.ts`

Expected: at least the controlled textarea or long Unicode case fails or times out with the current keyboard-only path.

- [x] **Step 3: Implement input-kind-specific entry**

For input/textarea, invoke the native prototype value setter and dispatch composed bubbling `beforeinput`, `input`, and `change` events. For contenteditable, focus and use `page.keyboard.insertText(text)` after select-all/backspace when clearing. Reread `value`/`innerText`; if it differs, return typed `INPUT_VALUE_MISMATCH` rather than reporting success. Register `INPUT_VALUE_MISMATCH` in `daemon_error_exit_code` (`cli/src/main.rs`) mapping to exit 3 and extend `maps_typed_agent_errors_to_stable_exit_codes`.

- [x] **Step 4: Run focused tests and commit**

Run: `cd daemon && pnpm vitest run src/react-input.test.ts src/interactive-actions.test.ts src/wait-engine-regressions.test.ts`

Commit: `fix(actions): make text entry react safe`

### Task 5: Diagnostics, structured QuickJS output, docs, and final acceptance

**Files:**
- Modify: `daemon/src/browser-manager.ts`
- Modify: `daemon/src/browser-manager-pages.test.ts`
- Modify: `daemon/src/sandbox/host-bridge.ts`
- Modify: `daemon/src/sandbox/quickjs-host.ts`
- Modify: `daemon/src/sandbox/__tests__/quickjs-host.test.ts`
- Modify: `cli/src/discovery.rs`
- Modify: `README.md`
- Modify: `cli/llm-guide.txt`

**Interfaces:**
- Consumes: CDP endpoint connection error and QuickJS serializable value.
- Produces: actionable no-listener diagnostic and `console.json(value)` as one bounded JSON line.

- [x] **Step 1: Write failing DX tests**

Assert that an `ECONNREFUSED` endpoint error includes the endpoint and a command hint to launch Chrome with `--remote-debugging-port=<port>`. Assert `console.json({ ok: true })` emits exactly one parseable JSON line and rejects cyclic/oversized values with bounded diagnostics.

- [x] **Step 2: Verify the tests fail**

Run: `cd daemon && pnpm vitest run src/browser-manager-pages.test.ts src/sandbox/__tests__/quickjs-host.test.ts`

- [x] **Step 3: Implement and document the DX surfaces**

Preserve the original CDP resolution error while appending a listener-specific recovery hint. Route `console.json` through the existing host bridge serializer and output limiter; do not expose filesystem APIs.

- [x] **Step 4: Update schema, capabilities, README, and LLM guide**

Document screenshot deadlines, scoped observe/text/assert, virtual container scans, React-safe typing, safe recipient workflow, error codes, and the exact non-destructive T1–T5 fixture commands. Include two workflow recipes (site-agnostic, no LinkedIn selectors): detecting an unavailable send button (`find --states disabled`; `click` on it returns `TARGET_DISABLED`) and verifying a thread actually opened before composing (real click, then `assert` on URL/header text) — deep links may not hydrate SPA panels, so a real click plus assertion is the reliable pattern.

- [x] **Step 5: Run the complete validation matrix**

Run:

```text
cd daemon && npx tsc --noEmit
cd daemon && pnpm vitest run
cd daemon && pnpm bundle
cd daemon && pnpm bundle:sandbox-client
cd cli && cargo +stable-x86_64-pc-windows-msvc fmt --check
cd cli && cargo +stable-x86_64-pc-windows-msvc test
cd cli && cargo +stable-x86_64-pc-windows-msvc build
cd cli && cargo +stable-x86_64-pc-windows-msvc build --release
```

- [x] **Step 6: Run local acceptance T1–T5 and review captures**

Start the reliability fixture and use the release binary to prove: screenshot under 8 seconds on perpetual animation; scoped main observation; virtual row discovery; opened-thread URL/header assertion; exact multiline compose value and enabled send button. Open resulting PNGs with an image viewer.

- [x] **Step 7: Commit documentation and discovery changes**

Commit: `docs(cli): document reliable linkedin workflows`

## Self-review

- B1 maps to Task 1; B2 and B5 map to Task 2; B3 maps to Task 3; B4 maps to Task 4; B6 and B7 map to Task 5.
- T1–T5 are reproduced locally without authenticated LinkedIn state. T8 (unavailable send button) is additionally covered locally by Task 4's disabled-composer fixture plus the existing `TARGET_DISABLED`/`find --states disabled` surfaces. T6, T7, T9, and T10-on-real-surfaces remain release-gated real-account acceptance and are explicitly non-automated to prevent outbound side effects.
- `AMBIGUOUS_TARGET` and `TARGET_DISABLED` already exist in the protocol and map to exit 3; the plan reuses them and registers only `ASSERTION_FAILED` and `INPUT_VALUE_MISMATCH` as new codes in the same family.
- `find` already supports `within` and `states`; Task 2 extends the same resolver to `observe`/`text`/`assert` instead of adding a second grammar.
- All new fields are bounded, protocol-v2 discoverable, typed on failure, and generic rather than LinkedIn-specific.
- No placeholder steps remain; each task has a failing test, implementation contract, focused verification, and atomic commit.
