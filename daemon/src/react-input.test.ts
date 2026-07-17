import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "./browser-manager.js";
import { stopBrowserManagerAndRemoveDirectory } from "./browser-test-cleanup.js";
import { executeInteractiveAction, type InteractiveResult } from "./interactive-actions.js";
import { pageLeases } from "./sessions.js";

const browserName = "react-input";

// A deterministic, site-agnostic stand-in for a React controlled component:
// the DOM value is only ever considered "committed" once both a bubbling
// `beforeinput` and a bubbling `input` event have reached the listener,
// which then re-renders the DOM value from local state and toggles the
// send button. A direct `.value = ...` assignment that skips those events
// never updates `composerState`/`textareaState`, so a subsequent (unrelated)
// render call would snap the DOM value back to the stale state -- the same
// trap a naive `element.value = text` assignment falls into against real
// React's value tracker.
const FIXTURE_HTML = `<!doctype html>
<html>
  <body>
    <input id="composer-input" aria-label="Composer input">
    <button id="composer-send" disabled>Send</button>

    <textarea id="composer-textarea" aria-label="Composer textarea"></textarea>
    <button id="composer-textarea-send" disabled>Send textarea</button>

    <div id="composer-note" contenteditable="true" role="textbox" aria-label="Composer note"></div>
    <button id="composer-note-send" disabled>Send note</button>

    <input id="truncating-input" aria-label="Truncating input" maxlength="5">

    <input id="secret-composer" type="password" aria-label="Secret composer">

    <input id="disabled-composer-input" aria-label="Disabled composer input">
    <button id="disabled-composer-send" disabled aria-label="Disabled composer send">Send disabled</button>

    <script>
      window.__composerState = "";
      window.__textareaState = "";
      window.__noteState = "";

      function wireControlled(input, sendButton, stateKey) {
        let sawBeforeInput = false;
        const render = () => {
          input.value = window[stateKey];
          sendButton.disabled = window[stateKey].length === 0;
        };
        input.addEventListener("beforeinput", () => { sawBeforeInput = true; });
        input.addEventListener("input", (event) => {
          if (!sawBeforeInput) return; // require realistic beforeinput -> input ordering
          sawBeforeInput = false;
          window[stateKey] = event.target.value;
          render();
        });
        render();
      }
      wireControlled(document.querySelector("#composer-input"), document.querySelector("#composer-send"), "__composerState");
      wireControlled(document.querySelector("#composer-textarea"), document.querySelector("#composer-textarea-send"), "__textareaState");

      const note = document.querySelector("#composer-note");
      const noteSend = document.querySelector("#composer-note-send");
      note.addEventListener("input", () => {
        window.__noteState = note.innerText;
        noteSend.disabled = window.__noteState.trim().length === 0;
      });

      // Simulates a field that enforces its own maxlength/validation rule by
      // rewriting the value on every input event, independent of whatever
      // was just written -- entry must reread and detect the mismatch.
      const truncating = document.querySelector("#truncating-input");
      truncating.addEventListener("input", (event) => {
        event.target.value = event.target.value.slice(0, 3);
      });
    </script>
  </body>
</html>`;

function request(
  page: string,
  action: Parameters<typeof executeInteractiveAction>[1]["action"]
): Parameters<typeof executeInteractiveAction>[1] {
  return {
    id: `test-${action.kind}`,
    type: "interactive",
    protocolVersion: 2,
    browser: browserName,
    page,
    action,
  };
}

function elements(result: InteractiveResult) {
  if (!("elements" in result) || !result.elements) {
    throw new Error("Expected interactive elements");
  }
  return result.elements;
}

describe.sequential("react-safe exact text entry", () => {
  let root = "";
  let manager: BrowserManager;
  let pageCounter = 0;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "dev-browser-react-input-"));
    manager = new BrowserManager(path.join(root, "browsers"));
    await manager.ensureBrowser(browserName, { headless: true });
  }, 180_000);

  afterAll(async () => {
    await stopBrowserManagerAndRemoveDirectory(manager, root);
  }, 180_000);

  // Every test gets its own freshly-created page (rather than resetting a
  // shared page's content via setContent between tests): a page containing
  // a contenteditable region does not reliably re-run its inline <script> on
  // a same-page setContent() reset in this Chromium/Playwright combination,
  // so a brand-new page/tab per test is the deterministic choice.
  async function freshPage() {
    pageCounter += 1;
    const pageName = `composer-${pageCounter}`;
    const page = await manager.getPage(browserName, pageName);
    await page.setContent(FIXTURE_HTML);
    return { page, pageName };
  }

  async function readElements(pageName: string) {
    const result = await executeInteractiveAction(
      manager,
      request(pageName, { kind: "read", limit: 100, depth: 12 })
    );
    return elements(result);
  }

  it("enters exact accented text into a controlled input via the native setter and enables send", async () => {
    const { page, pageName } = await freshPage();
    const field = (await readElements(pageName)).find((element) => element.name === "Composer input")!;
    const result = await executeInteractiveAction(
      manager,
      request(pageName, { kind: "type", ref: field.ref, text: "Café — À bientôt", clear: true, delayMs: 0 })
    );

    expect(result.inputStrategy).toBe("native-setter");
    expect(result.verifiedValue).toBe("Café — À bientôt");

    await expect(page.locator("#composer-input").inputValue()).resolves.toBe("Café — À bientôt");
    await expect(page.locator("#composer-send").isDisabled()).resolves.toBe(false);
    await expect(page.evaluate(() => (window as unknown as { __composerState: string }).__composerState)).resolves.toBe(
      "Café — À bientôt"
    );
  });

  it("replaces existing controlled-input content exactly rather than appending", async () => {
    const { page, pageName } = await freshPage();
    const first = (await readElements(pageName)).find((element) => element.name === "Composer input")!;
    await executeInteractiveAction(
      manager,
      request(pageName, { kind: "type", ref: first.ref, text: "Original draft", clear: true, delayMs: 0 })
    );

    const second = (await readElements(pageName)).find((element) => element.name === "Composer input")!;
    const result = await executeInteractiveAction(
      manager,
      request(pageName, { kind: "type", ref: second.ref, text: "Replacement message", clear: true, delayMs: 0 })
    );

    expect(result.verifiedValue).toBe("Replacement message");
    await expect(page.locator("#composer-input").inputValue()).resolves.toBe("Replacement message");
  });

  it("clears a controlled input to empty text and disables send again", async () => {
    const { page, pageName } = await freshPage();
    const first = (await readElements(pageName)).find((element) => element.name === "Composer input")!;
    await executeInteractiveAction(
      manager,
      request(pageName, { kind: "type", ref: first.ref, text: "Something", clear: true, delayMs: 0 })
    );
    await expect(page.locator("#composer-send").isDisabled()).resolves.toBe(false);

    const second = (await readElements(pageName)).find((element) => element.name === "Composer input")!;
    const result = await executeInteractiveAction(
      manager,
      request(pageName, { kind: "type", ref: second.ref, text: "", clear: true, delayMs: 0 })
    );

    expect(result.verifiedValue).toBe("");
    await expect(page.locator("#composer-input").inputValue()).resolves.toBe("");
    await expect(page.locator("#composer-send").isDisabled()).resolves.toBe(true);
  });

  it("appends deterministically at the end with clear: false on input and textarea", async () => {
    const { page, pageName } = await freshPage();
    const input = (await readElements(pageName)).find((element) => element.name === "Composer input")!;
    await executeInteractiveAction(
      manager,
      request(pageName, { kind: "type", ref: input.ref, text: "Hello", clear: true, delayMs: 0 })
    );

    const inputAgain = (await readElements(pageName)).find((element) => element.name === "Composer input")!;
    const appended = await executeInteractiveAction(
      manager,
      request(pageName, { kind: "type", ref: inputAgain.ref, text: " world", clear: false, delayMs: 0 })
    );
    expect(appended.inputStrategy).toBe("native-setter");
    expect(appended.verifiedValue).toBe("Hello world");
    await expect(page.locator("#composer-input").inputValue()).resolves.toBe("Hello world");
    await expect(page.locator("#composer-send").isDisabled()).resolves.toBe(false);

    const textarea = (await readElements(pageName)).find((element) => element.name === "Composer textarea")!;
    await executeInteractiveAction(
      manager,
      request(pageName, { kind: "type", ref: textarea.ref, text: "Line one", clear: true, delayMs: 0 })
    );
    const textareaAgain = (await readElements(pageName)).find(
      (element) => element.name === "Composer textarea"
    )!;
    const appendedTextarea = await executeInteractiveAction(
      manager,
      request(pageName, { kind: "type", ref: textareaAgain.ref, text: "\nLine two", clear: false, delayMs: 0 })
    );
    expect(appendedTextarea.verifiedValue).toBe("Line one\nLine two");
    await expect(page.locator("#composer-textarea").inputValue()).resolves.toBe("Line one\nLine two");
    await expect(page.locator("#composer-textarea-send").isDisabled()).resolves.toBe(false);
  });

  it("enters exact accented multiline text into a controlled textarea", async () => {
    const { page, pageName } = await freshPage();
    const field = (await readElements(pageName)).find((element) => element.name === "Composer textarea")!;
    const text = "Bonjour à tous,\nMerci pour votre réponse rapide.\nÀ bientôt !";
    const result = await executeInteractiveAction(
      manager,
      request(pageName, { kind: "type", ref: field.ref, text, clear: true, delayMs: 0 })
    );

    expect(result.inputStrategy).toBe("native-setter");
    expect(result.verifiedValue).toBe(text);

    await expect(page.locator("#composer-textarea").inputValue()).resolves.toBe(text);
    await expect(page.locator("#composer-textarea-send").isDisabled()).resolves.toBe(false);
  });

  it("enters an exact 2,000-character message into a controlled textarea", async () => {
    const { page, pageName } = await freshPage();
    const longText = `${"Bonjour café — "}${"a".repeat(2_000)}`.slice(0, 2_000);
    const field = (await readElements(pageName)).find((element) => element.name === "Composer textarea")!;
    const result = await executeInteractiveAction(
      manager,
      request(pageName, { kind: "type", ref: field.ref, text: longText, clear: true, delayMs: 0 })
    );

    expect(result.verifiedValue).toBe(longText);
    expect(result.verifiedValue?.length).toBe(2_000);
    await expect(page.locator("#composer-textarea").inputValue()).resolves.toBe(longText);
    await expect(page.locator("#composer-textarea-send").isDisabled()).resolves.toBe(false);
  });

  it("enters exact accented multiline text into a contenteditable via focus + insertText", async () => {
    const { page, pageName } = await freshPage();
    const field = (await readElements(pageName)).find((element) => element.name === "Composer note")!;
    const text = "Bonjour,\nMerci beaucoup — à bientôt.";
    const result = await executeInteractiveAction(
      manager,
      request(pageName, { kind: "type", ref: field.ref, text, clear: true, delayMs: 0 })
    );

    expect(result.inputStrategy).toBe("insert-text");
    expect(result.verifiedValue).toBe(text);

    await expect(page.locator("#composer-note").innerText()).resolves.toBe(text);
    await expect(page.locator("#composer-note-send").isDisabled()).resolves.toBe(false);
    await expect(page.evaluate(() => (window as unknown as { __noteState: string }).__noteState)).resolves.toBe(text);
  });

  it("rechecks leases between the contenteditable clear and insertText trusted inputs", async () => {
    const { page, pageName } = await freshPage();
    const setup = (await readElements(pageName)).find((element) => element.name === "Composer note")!;
    await executeInteractiveAction(
      manager,
      request(pageName, { kind: "type", ref: setup.ref, text: "Draft to be replaced", clear: true, delayMs: 0 })
    );

    // Contenteditable clear performs three trusted dispatches: mouse focus
    // click, select-all+Backspace, insertText. Open a conflicting lease
    // right before the third so the conflict arises BETWEEN the clear and
    // the insert — it must be caught, not silently ridden through.
    const field = (await readElements(pageName)).find((element) => element.name === "Composer note")!;
    let dispatches = 0;
    let lease: ReturnType<typeof pageLeases.open> | undefined;
    try {
      await expect(
        executeInteractiveAction(
          manager,
          request(pageName, { kind: "type", ref: field.ref, text: "must-not-insert", clear: true, delayMs: 0 }),
          {
            beforeTrustedInput: () => {
              dispatches += 1;
              if (dispatches === 3) lease = pageLeases.open(browserName, pageName, 300);
            },
          }
        )
      ).rejects.toMatchObject({
        code: "LEASE_CONFLICT",
        details: {
          attemptJournal: [
            { inputMethod: "mouse", reason: "action-complete" },
            { inputMethod: "keyboard", reason: "action-complete" },
            { inputMethod: "keyboard", reason: "lease-conflict" },
          ],
        },
      });
    } finally {
      if (lease) pageLeases.close(lease.sessionId);
    }

    // The clear ran (second dispatch) but the blocked insertText did not:
    // the previous draft is gone (at most a residual <br> newline remains
    // after clearing a contenteditable) and no new text was inserted.
    const remaining = await page.locator("#composer-note").innerText();
    expect(remaining.trim()).toBe("");
    expect(remaining).not.toContain("must-not-insert");
  });

  it("redacts verifiedValue for password fields", async () => {
    const { pageName } = await freshPage();
    const secret = "hunter2-secret-value";
    const field = (await readElements(pageName)).find((element) => element.name === "Secret composer")!;
    const result = await executeInteractiveAction(
      manager,
      request(pageName, { kind: "type", ref: field.ref, text: secret, clear: true, delayMs: 0 })
    );

    expect(result.inputStrategy).toBe("native-setter");
    expect(result.verifiedValue).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("returns typed INPUT_VALUE_MISMATCH instead of reporting success when the field rejects the value", async () => {
    const { page, pageName } = await freshPage();
    const field = (await readElements(pageName)).find((element) => element.name === "Truncating input")!;
    await expect(
      executeInteractiveAction(
        manager,
        request(pageName, { kind: "type", ref: field.ref, text: "way too long", clear: true, delayMs: 0 })
      )
    ).rejects.toMatchObject({ code: "INPUT_VALUE_MISMATCH", recoverable: true });

    // The field's own validation logic ran (truncated to 3 chars); dev-browser
    // must not have reported this as a successful exact-text entry.
    await expect(page.locator("#truncating-input").inputValue()).resolves.toBe("way");
  });

  it("surfaces a disabled composer send button via find --states disabled", async () => {
    const { pageName } = await freshPage();
    const result = await executeInteractiveAction(
      manager,
      request(pageName, {
        kind: "find",
        name: "Disabled composer send",
        nameMode: "exact",
        states: ["disabled"],
        limit: 10,
      })
    );

    expect(result.matches?.some((match) => match.name === "Disabled composer send")).toBe(true);
  });

  it("fails a click on a disabled composer send button with TARGET_DISABLED, never reporting success", async () => {
    const { pageName } = await freshPage();
    const button = (await readElements(pageName)).find((element) => element.name === "Disabled composer send")!;
    await expect(
      executeInteractiveAction(manager, request(pageName, { kind: "click", ref: button.ref, method: "locator" }))
    ).rejects.toMatchObject({ code: "TARGET_DISABLED" });
  });
});
