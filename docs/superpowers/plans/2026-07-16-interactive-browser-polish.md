# Interactive Browser Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate stale modal state, make click outcomes observable, align screenshot and click coordinates, and resolve refs to the most actionable nested control.

**Architecture:** Extend the existing interactive Playwright engine with a shared post-action perception function and before/after page signals. Screenshots explicitly use CSS-pixel scale, while ref resolution selects a visible interactive descendant or ancestor before dispatching trusted input.

**Tech Stack:** TypeScript, Playwright 1.61.1, Zod, Rust/clap, Vitest.

## Global Constraints

- `find` performs a fresh DOM annotation and ARIA snapshot on every call.
- `navigate`, `click`, and `type` return refreshed refs and ARIA state after the action.
- `--wait-for` retries a click at most once and only when no observable change occurred.
- Guarded clicks using `--expect-text` are never retried automatically.
- Screenshots and `--xy` use CSS viewport pixels.
- Input remains trusted Playwright mouse/keyboard/locator input.

---

### Task 1: Fresh perception and coordinate contract

**Files:**
- Modify: `daemon/src/interactive-actions.ts`
- Modify: `daemon/src/interactive-actions.test.ts`

**Interfaces:**
- Produces: `coordinateSpace: { unit: "css-px"; screenshotScale: "css"; viewport: { width; height }; devicePixelRatio }`.
- Produces refreshed `snapshot` and `elements` for `find`, `navigate`, `click`, and `type`.

- [x] **Step 1: Write failing tests**

Verify a modal opened by click appears in that same click result, `find` sees DOM inserted after a prior read, and a DPR=2 page screenshot width equals its CSS viewport width.

- [x] **Step 2: Run focused tests and verify failure**

Run: `cd daemon && pnpm vitest run src/interactive-actions.test.ts`

Expected: FAIL because post-action perception and coordinate metadata are absent.

- [x] **Step 3: Implement shared perception**

Add `perceivePage(page, { limit, depth })` returning fresh refs, ARIA snapshot, and coordinate metadata. Call it on every `read` and `find`, and after successful `navigate`, `click`, and `type`.

- [x] **Step 4: Force CSS-pixel screenshots**

Use:

```ts
await page.screenshot({ scale: "css" });
```

Expose the viewport size and DPR in every attached page result so screenshot coordinates can be passed directly to `--xy`.

- [x] **Step 5: Run focused tests**

Run: `cd daemon && pnpm vitest run src/interactive-actions.test.ts`

Expected: PASS.

---

### Task 2: Click change reporting, wait, and ref fallback

**Files:**
- Modify: `daemon/src/protocol.ts`
- Modify: `daemon/src/protocol.test.ts`
- Modify: `daemon/src/interactive-actions.ts`
- Modify: `daemon/src/interactive-actions.test.ts`

**Interfaces:**
- Consumes click option: `waitForText?: string`.
- Produces click result: `{ attempts, waitForText, waitSatisfied, change: { any, url, snapshot, dialog, ariaExpanded } }`.
- Produces clicked target metadata: `{ ref, resolvedBy: "self" | "descendant" | "ancestor" }`.

- [x] **Step 1: Write failing protocol and action tests**

Cover `waitForText`, a click that opens a dialog, a no-op first click followed by one successful retry, no retry after any observable change, no retry with `expectText`, and a link ref wrapping a button that resolves to the descendant.

- [x] **Step 2: Verify focused failure**

Run: `cd daemon && pnpm vitest run src/protocol.test.ts src/interactive-actions.test.ts`

Expected: FAIL on the new fields and behaviors.

- [x] **Step 3: Capture page signals**

Before and after input, capture URL, ARIA snapshot, visible dialog text/count, and all visible `[aria-expanded]` values. Report which dimensions changed.

- [x] **Step 4: Implement bounded wait/retry**

After click, poll visible body/dialog text until the request timeout. If expected text is absent and `change.any` is false, repeat the trusted click exactly once unless `expectText` was supplied. Poll again and return `attempts` plus `waitSatisfied`; fail with the final observed text when the wait remains unsatisfied.

- [x] **Step 5: Implement actionable ref resolution**

For a link ref with a visible button or `[role=button]` descendant, click that descendant. If the original element is not visible/actionable, use the nearest visible interactive ancestor. Return how the target was resolved.

- [x] **Step 6: Run focused tests**

Run: `cd daemon && pnpm vitest run src/protocol.test.ts src/interactive-actions.test.ts`

Expected: PASS.

---

### Task 3: CLI option, docs, and final validation

**Files:**
- Modify: `cli/src/main.rs`
- Modify: `cli/llm-guide.txt`
- Modify: `README.md`

**Interfaces:**
- Produces: `dev-browser click --wait-for "Expected UI text"`.

- [x] **Step 1: Write a failing Rust parsing test**

Verify `click --ref R12 --wait-for "Invitation sent"` produces `waitForText` in the interactive request.

- [x] **Step 2: Implement and document `--wait-for`**

Describe the one-retry rule, the no-retry guarded-click rule, automatic post-action snapshots, and CSS-pixel coordinate contract in command help and the LLM guide.

- [x] **Step 3: Run full validation**

Run:

```powershell
cd daemon
npx tsc --noEmit
pnpm vitest run
pnpm bundle
pnpm bundle:sandbox-client
cd ../cli
cargo +stable-x86_64-pc-windows-msvc test
cargo +stable-x86_64-pc-windows-msvc build --release
```

Expected: all commands exit 0.

- [x] **Step 4: Verify visually and globally**

Use the compiled CLI on a deterministic page to verify a screenshot coordinate clicks the intended element, a modal appears in the click result without a separate read, and `--wait-for` reports success. Install the release binary globally and confirm `dev-browser click --help` exposes the option.

- [x] **Step 5: Review the worktree**

Run: `git diff --check && git status --short`

Expected: only the interactive feature, polish, tests, plans, and documentation are modified.
