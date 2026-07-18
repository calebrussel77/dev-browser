import type { Locator, Page } from "playwright";

import { AgentProtocolError } from "./agent-protocol.js";

/**
 * How exact text entry was delivered into the resolved target:
 * - "native-setter": input/textarea via the native prototype value setter
 *   plus composed bubbling beforeinput/input/change events (React-safe).
 * - "insert-text": contenteditable via focus + trusted keyboard.insertText.
 * - "keyboard": fallback trusted key-by-key typing for anything else, or
 *   when no ref was resolved (whatever currently holds focus).
 */
export type InputStrategy = "native-setter" | "insert-text" | "keyboard";

/**
 * Wraps every discrete trusted browser input (a keyboard press, an
 * insertText, or the setter+events evaluation) so the caller can revalidate
 * leases / refs and journal each real input individually. Defaults to
 * executing the input directly when the caller does not need that hook.
 */
export type TrustedInputDispatch = (input: () => Promise<void>) => Promise<void>;

export interface EnterExactTextResult {
  strategy: InputStrategy;
  /**
   * The value/innerText reread from the live element after entry, verified
   * to exactly match the expected text. Populated for native-setter,
   * insert-text, and the contenteditable keyboard fallback (all reread and
   * verified). Undefined only for the last-resort "keyboard" entry into an
   * unrecognized target, which has no site-agnostic value contract to reread
   * and therefore reports the entry as unverified.
   */
  verifiedValue?: string;
}

export interface EnterExactTextOptions {
  page: Page;
  locator: Locator;
  text: string;
  clear: boolean;
  /** Only applies to the "keyboard" fallback strategy's key-by-key typing. */
  delayMs?: number;
  dispatch?: TrustedInputDispatch;
}

type ElementKind = "input" | "textarea" | "contenteditable" | "other";

async function classifyElement(locator: Locator): Promise<ElementKind> {
  return locator.evaluate((element): ElementKind => {
    const tag = element.tagName.toLowerCase();
    if (tag === "input") return "input";
    if (tag === "textarea") return "textarea";
    if ((element as HTMLElement).isContentEditable) return "contenteditable";
    return "other";
  });
}

async function readControlValue(locator: Locator): Promise<string> {
  return locator.evaluate((element) => (element as HTMLInputElement | HTMLTextAreaElement).value);
}

async function readEditableText(locator: Locator): Promise<string> {
  return locator.evaluate((element) => (element as HTMLElement).innerText);
}

/**
 * Normalizes a contenteditable's innerText for verification. Rich-text editors
 * wrap each logical line in a block element, so a single typed newline reads
 * back as a paragraph break (`\n\n`) and a trailing block adds a final newline.
 * Collapsing CRLF, runs of newlines, and trailing whitespace lets an entry that
 * is visually exact verify as a match, while still catching genuine corruption
 * (dropped characters, truncation, transformed content), which changes the text
 * itself rather than only its block/whitespace framing.
 */
function normalizeEditableText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\s+$/g, "");
}

/**
 * Empties a focused contenteditable with one discrete trusted input:
 * select all of its children, then a real Backspace. Shared by the initial
 * clear and the keyboard-fallback reset so both go through the same path.
 */
async function clearEditable(locator: Locator, page: Page): Promise<void> {
  await locator.evaluate((element) => {
    const target = element as HTMLElement;
    target.ownerDocument.getSelection()?.selectAllChildren(target);
  });
  await page.keyboard.press("Backspace");
}

/**
 * Sets an input/textarea's value through the native prototype setter (so
 * React's own value-tracker sees a real change instead of silently
 * swallowing a direct `.value =` assignment) and then dispatches composed,
 * bubbling `beforeinput`, `input`, and `change` events in DOM order so
 * controlled-component listeners observe the same sequence a real keystroke
 * would produce.
 */
async function applyNativeSetterValue(locator: Locator, nextValue: string): Promise<void> {
  await locator.evaluate((element, value) => {
    const target = element as HTMLInputElement | HTMLTextAreaElement;
    const prototype =
      target.tagName.toLowerCase() === "textarea"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) throw new Error("Native value setter unavailable for this element");

    const inputType = value.length === 0 ? "deleteContentBackward" : "insertText";
    target.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        composed: true,
        cancelable: true,
        data: value.length === 0 ? null : value,
        inputType,
      })
    );
    setter.call(target, value);
    target.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        cancelable: false,
        data: value.length === 0 ? null : value,
        inputType,
      })
    );
    target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }, nextValue);
}

/**
 * Enters exact Unicode text into a resolved input/textarea/contenteditable
 * target using the input-kind-specific, React-safe strategy, then rereads
 * the live value/innerText to verify it matches exactly. Never reports
 * success on a mismatch: throws a typed INPUT_VALUE_MISMATCH instead.
 *
 * Semantics with `clear: false` on input/textarea are a deterministic
 * append-at-end: the new value is `previous value + text`, independent of
 * any caret position (unlike interactive typing, which inserts wherever the
 * cursor happens to be). This keeps the exact-value verification contract
 * well-defined. Contenteditable without `clear` likewise collapses the
 * selection to the end before inserting, so it appends too.
 *
 * Every discrete trusted browser input runs through `options.dispatch`
 * (when provided) so the caller can revalidate leases/refs and journal each
 * real input individually — the contenteditable clear path performs two
 * separate trusted inputs (select-all + Backspace, then insertText) and
 * each goes through its own dispatch.
 */
export async function enterExactText(options: EnterExactTextOptions): Promise<EnterExactTextResult> {
  const dispatch: TrustedInputDispatch = options.dispatch ?? ((input) => input());
  const kind = await classifyElement(options.locator);

  if (kind === "input" || kind === "textarea") {
    const previous = await readControlValue(options.locator);
    const expected = options.clear ? options.text : previous + options.text;
    await dispatch(() => applyNativeSetterValue(options.locator, expected));
    const verifiedValue = await readControlValue(options.locator);
    if (verifiedValue !== expected) {
      throw new AgentProtocolError(
        "INPUT_VALUE_MISMATCH",
        "Typed value did not match after native-setter entry; the field may reject, mask, or transform input",
        true,
        { details: { strategy: "native-setter", expectedLength: expected.length, actualLength: verifiedValue.length } }
      );
    }
    return { strategy: "native-setter", verifiedValue };
  }

  if (kind === "contenteditable") {
    await options.locator.evaluate((element) => (element as HTMLElement).focus());
    let previous = "";
    if (options.clear) {
      // Select-all + Backspace is one discrete trusted input; the insertText
      // below is a second one. Each gets its own dispatch so a lease
      // conflict or stale ref arising between them is still caught.
      await dispatch(() => clearEditable(options.locator, options.page));
    } else {
      previous = await readEditableText(options.locator);
      await options.locator.evaluate((element) => {
        const target = element as HTMLElement;
        const selection = target.ownerDocument.getSelection();
        selection?.selectAllChildren(target);
        selection?.collapseToEnd();
      });
    }
    const expected = previous + options.text;
    const expectedNormalized = normalizeEditableText(expected);
    await dispatch(() => options.page.keyboard.insertText(options.text));
    let verifiedValue = await readEditableText(options.locator);
    if (normalizeEditableText(verifiedValue) === expectedNormalized)
      return { strategy: "insert-text", verifiedValue };

    // A single bulk insertText is dropped by rich-text editors (Draft.js /
    // Lexical-style) that manage their own model from per-keystroke events.
    // Reset to a known-empty baseline and re-enter the full expected text with
    // real key-by-key input, which those editors do commit, then re-verify.
    await dispatch(() => clearEditable(options.locator, options.page));
    await dispatch(() => options.page.keyboard.type(expected, { delay: options.delayMs }));
    verifiedValue = await readEditableText(options.locator);
    if (normalizeEditableText(verifiedValue) !== expectedNormalized) {
      throw new AgentProtocolError(
        "INPUT_VALUE_MISMATCH",
        "Typed value did not match after insert-text and keyboard entry; the editable region may reject or transform input",
        true,
        { details: { strategy: "keyboard", expectedLength: expected.length, actualLength: verifiedValue.length } }
      );
    }
    return { strategy: "keyboard", verifiedValue };
  }

  // Unrecognized element kind: no site-agnostic value/innerText contract to
  // reread, so keep the trusted keyboard fallback and report the entry as
  // unverified (verifiedValue stays undefined). delayMs applies here only.
  await dispatch(() => options.page.keyboard.type(options.text, { delay: options.delayMs }));
  return { strategy: "keyboard" };
}
