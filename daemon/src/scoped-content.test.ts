import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { collectPageState } from "./perception/collector.js";
import { assertScopedText, isValidWithinScope, resolveContentScope } from "./scoped-content.js";
import { findTargets, landmarkScopeMatches } from "./targeting.js";

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

  it("accepts find's within grammar (any landmark substring) plus role:/name: extensions", () => {
    // Base grammar is find's: any landmark-descriptor substring is valid.
    expect(isValidWithinScope("main")).toBe(true);
    expect(isValidWithinScope("aside")).toBe(true);
    expect(isValidWithinScope("dialog")).toBe(true);
    expect(isValidWithinScope("nav")).toBe(true);
    expect(isValidWithinScope("conversation-list")).toBe(true);
    // Extensions.
    expect(isValidWithinScope("role:list")).toBe(true);
    expect(isValidWithinScope("name:Thread")).toBe(true);
    // Bounds.
    expect(isValidWithinScope("")).toBe(false);
    expect(isValidWithinScope("role:")).toBe(false);
    expect(isValidWithinScope("name:")).toBe(false);
    expect(isValidWithinScope("x".repeat(501))).toBe(false);

    // The Node-side matcher extracted from findTargets encodes the same
    // semantic the in-page resolvers duplicate.
    expect(landmarkScopeMatches("section#conversation-list", "conversation-list")).toBe(true);
    expect(landmarkScopeMatches("nav#primary", "nav")).toBe(true);
    expect(landmarkScopeMatches("div[role=dialog]", "dialog")).toBe(true);
    expect(landmarkScopeMatches("main", "aside")).toBe(false);
  });

  it("resolves any landmark substring the way find's within filter matches it", async () => {
    await page.setContent(`
      <nav id="primary"><a href="#one">Nav link</a></nav>
      <main>
        <section id="records-pane">
          <button>Record action</button>
          <p>Record body</p>
        </section>
        <section id="other-pane"><button>Other action</button></section>
      </main>
    `);

    // Bare tag landmark (previously rejected by the closed enum).
    const navText = await resolveContentScope(page, { within: "nav" });
    expect(navText.text).toContain("Nav link");

    // Custom id-based landmark substring, matching find's normalize semantic.
    const scoped = await collectPageState(page, {
      track: "landmark-scope",
      scope: { within: "records-pane" },
    });
    const scopedNames = scoped.elements
      .filter((element) => element.actionable)
      .map((element) => element.name)
      .sort();
    expect(scopedNames).toEqual(["Record action"]);

    // Equivalence with find: the actionable elements inside the scope are
    // exactly those find's within filter selects from a full observation.
    const full = await collectPageState(page, { track: "landmark-full" });
    const findFiltered = findTargets(
      full.elements.filter((element) => element.actionable),
      { within: "records-pane", scope: "document", states: [] },
      50
    ).matches.map((match) => match.name).sort();
    expect(findFiltered).toEqual(scopedNames);
  });

  it("collapses nested landmark matches to the outermost container instead of reporting ambiguity", async () => {
    await page.setContent(`
      <aside id="outer">
        <p>Outer text</p>
        <aside id="inner"><p>Inner text</p></aside>
      </aside>
    `);

    const result = await resolveContentScope(page, { within: "aside" });
    expect(result.text).toContain("Outer text");
    expect(result.text).toContain("Inner text");

    const observed = await collectPageState(page, {
      track: "nested-aside",
      scope: { within: "aside" },
    });
    expect(observed.tree).toContain("Inner text");
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

  it("resolves name: scopes with identical bounded-name semantics in observe and text paths", async () => {
    // aria-label longer than the shared 180-char compact bound: both the
    // observe path (realm-collector) and the text/assert path
    // (scoped-content) must truncate identically, so the full label misses
    // in both and the 180-char prefix matches in both.
    const longLabel = "L".repeat(100) + "R".repeat(100);
    const truncatedLabel = longLabel.slice(0, 180);
    await page.setContent(
      `<main><section aria-label="${longLabel}"><p>Bounded name body</p></section></main>`
    );

    await expect(
      resolveContentScope(page, { within: `name:${longLabel}` })
    ).rejects.toMatchObject({ code: "TARGET_MISSING" });
    await expect(
      collectPageState(page, { track: "long-name-observe", scope: { within: `name:${longLabel}` } })
    ).rejects.toMatchObject({ code: "TARGET_MISSING" });

    const textPath = await resolveContentScope(page, { within: `name:${truncatedLabel}` });
    expect(textPath.text).toContain("Bounded name body");
    const observePath = await collectPageState(page, {
      track: "long-name-observe-2",
      scope: { within: `name:${truncatedLabel}` },
    });
    expect(observePath.tree).toContain("Bounded name body");
  });

  it("scopes observation to a ref root, accepting both bare and F0-prefixed forms", async () => {
    await page.setContent(`
      <main>
        <section id="pane" tabindex="0">
          <button>Inside pane</button>
        </section>
        <button>Outside pane</button>
      </main>
    `);
    const full = await collectPageState(page, { track: "root-ref-full" });
    const paneRef = full.elements.find(
      (element) => element.actionable && element.name === "Inside pane" && element.role === "section"
    )?.ref;
    expect(paneRef).toMatch(/^R\d+$/);

    const bare = await collectPageState(page, { track: "root-ref-bare", scope: { ref: paneRef } });
    expect(bare.elements.some((element) => element.name === "Inside pane")).toBe(true);
    expect(bare.tree).not.toContain("Outside pane");
    expect(bare.scope).toMatchObject({ kind: "ref", value: paneRef });

    const prefixed = await collectPageState(page, {
      track: "root-ref-prefixed",
      scope: { ref: `F0:${paneRef}` },
    });
    expect(prefixed.elements.some((element) => element.name === "Inside pane")).toBe(true);
    expect(prefixed.tree).not.toContain("Outside pane");

    await expect(
      collectPageState(page, { track: "root-ref-cross-frame", scope: { ref: "F3:R1" } })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CONTEXT" });
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
