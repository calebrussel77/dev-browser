import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { collectPageState } from "./perception/collector.js";
import { assertScopedText, isValidWithinScope, resolveContentScope } from "./scoped-content.js";

describe.sequential("scoped observation, subtree text, and context assertions", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  });

  afterAll(async () => {
    await browser?.close();
  }, 30_000);

  const sidebarNodeCount = 160;
  const conversationRowCount = 40;

  async function loadThreadFixture() {
    const sidebar = Array.from(
      { length: sidebarNodeCount },
      (_, index) => `<p>Sidebar filler ${index}</p>`
    ).join("");
    const rows = Array.from(
      { length: conversationRowCount },
      (_, index) => `<p>Conversation with Contact ${index}</p>`
    ).join("");
    await page.setContent(`
      <header>${sidebar}</header>
      <main>
        <div id="rows">${rows}</div>
        <section aria-label="Thread">
          <p>You: Following up on the proposal</p>
          <p>Prospect: Sounds good, sending the contract now</p>
        </section>
      </main>
    `);
  }

  it("validates the within grammar shared with find (main, aside, dialog, role:, name:)", () => {
    expect(isValidWithinScope("main")).toBe(true);
    expect(isValidWithinScope("aside")).toBe(true);
    expect(isValidWithinScope("dialog")).toBe(true);
    expect(isValidWithinScope("role:list")).toBe(true);
    expect(isValidWithinScope("name:Thread")).toBe(true);
    expect(isValidWithinScope("nav")).toBe(false);
    expect(isValidWithinScope("")).toBe(false);
  });

  it("scopes observation to main's subtree without spending the node budget outside it", async () => {
    await loadThreadFixture();

    const scoped = await collectPageState(page, {
      maxNodes: 60,
      track: "scoped-main",
      scope: { within: "main" },
    });

    const rowNames = scoped.elements
      .filter((element) => element.name.startsWith("Conversation with Contact"))
      .map((element) => element.name);
    expect(rowNames).toHaveLength(conversationRowCount);
    expect(scoped.tree).not.toContain("Sidebar filler");
    expect(scoped.scope).toMatchObject({ kind: "within", value: "main" });
    expect(scoped.truncation.truncated).toBe(false);

    const unscoped = await collectPageState(page, { maxNodes: 60, track: "unscoped-main" });
    expect(unscoped.elements.some((element) => element.name.startsWith("Sidebar filler"))).toBe(
      true
    );
    expect(
      unscoped.elements.some((element) => element.name.startsWith("Conversation with Contact"))
    ).toBe(false);
  });

  it("rejects an ambiguous within scope with the existing AMBIGUOUS_TARGET code", async () => {
    await page.setContent(`<aside>First</aside><main><aside>Second</aside></main>`);

    await expect(
      collectPageState(page, { track: "ambiguous-within", scope: { within: "aside" } })
    ).rejects.toMatchObject({ code: "AMBIGUOUS_TARGET", recoverable: true });
  });

  it("rejects a within scope with no match as a typed, recoverable error", async () => {
    await page.setContent(`<main><p>No dialog here</p></main>`);

    await expect(
      collectPageState(page, { track: "missing-within", scope: { within: "dialog" } })
    ).rejects.toMatchObject({ code: "TARGET_MISSING", recoverable: true });
  });

  it("returns bounded normalized textOnly innerText for a scoped observe", async () => {
    await loadThreadFixture();

    const state = await collectPageState(page, {
      track: "text-only",
      scope: { within: "name:Thread" },
      textOnly: true,
    });

    expect(state.textOnly?.text).toContain("You: Following up on the proposal");
    expect(state.textOnly?.text).toContain("Prospect: Sounds good, sending the contract now");
    expect(state.textOnly?.text.split("\n").length).toBeGreaterThan(1);
    expect(state.textOnly?.truncation).toMatchObject({ truncated: false });
  });

  it("preserves multiline text when resolving a ref-scoped text read", async () => {
    // tabindex makes the container itself actionable (and therefore ref-able)
    // while <br> forces genuine line breaks that innerText must preserve.
    await page.setContent(
      `<main><article id="note" tabindex="0">Line one<br>Line two<br>Line three</article></main>`
    );
    const state = await collectPageState(page, { track: "ref-for-text" });
    const ref = state.elements.find(
      (element) => element.actionable && element.name.startsWith("Line one")
    )?.ref;
    expect(ref).toBeTruthy();

    const result = await resolveContentScope(page, { ref });
    expect(result.text).toContain("Line one");
    expect(result.text).toContain("Line two");
    expect(result.text).toContain("Line three");
    expect(result.text.includes("\n")).toBe(true);
    expect(result.scope).toMatchObject({ kind: "ref", value: ref });
  });

  it("asserts scoped text without mutating the page", async () => {
    await loadThreadFixture();

    const passed = await assertScopedText(page, {
      within: "name:Thread",
      text: "Sounds good, sending the contract",
      match: "contains",
    });
    expect(passed).toMatchObject({ asserted: true });
    expect(passed.observed).toContain("Sounds good");
  });

  it("fails a typed, recoverable ASSERTION_FAILED without a trusted input attempt when recipient text is absent", async () => {
    await loadThreadFixture();
    const before = await page.content();

    await expect(
      assertScopedText(page, {
        within: "name:Thread",
        text: "Jane Doe does not appear in this thread",
        match: "contains",
      })
    ).rejects.toMatchObject({ code: "ASSERTION_FAILED", recoverable: true });

    const after = await page.content();
    expect(after).toBe(before);
  });
});
