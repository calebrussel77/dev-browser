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

export interface EnterExactTextResult {
  strategy: InputStrategy;
  verifiedValue: string;
}

export interface EnterExactTextOptions {
  page: Page;
  locator: Locator;
  text: string;
  clear: boolean;
  delayMs?: number;
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
 */
export async function enterExactText(options: EnterExactTextOptions): Promise<EnterExactTextResult> {
  const kind = await classifyElement(options.locator);

  if (kind === "input" || kind === "textarea") {
    const previous = await readControlValue(options.locator);
    const expected = options.clear ? options.text : previous + options.text;
    await applyNativeSetterValue(options.locator, expected);
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
      await options.locator.evaluate((element) => {
        const target = element as HTMLElement;
        target.ownerDocument.getSelection()?.selectAllChildren(target);
      });
      await options.page.keyboard.press("Backspace");
    } else {
      previous = await readEditableText(options.locator);
      await options.locator.evaluate((element) => {
        const target = element as HTMLElement;
        const selection = target.ownerDocument.getSelection();
        selection?.selectAllChildren(target);
        selection?.collapseToEnd();
      });
    }
    await options.page.keyboard.insertText(options.text);
    const verifiedValue = await readEditableText(options.locator);
    const expected = previous + options.text;
    if (verifiedValue !== expected) {
      throw new AgentProtocolError(
        "INPUT_VALUE_MISMATCH",
        "Typed value did not match after insert-text entry; the editable region may reject or transform input",
        true,
        { details: { strategy: "insert-text", expectedLength: expected.length, actualLength: verifiedValue.length } }
      );
    }
    return { strategy: "insert-text", verifiedValue };
  }

  // Unrecognized element kind: no site-agnostic value/innerText contract to
  // verify against, so keep the trusted keyboard fallback without asserting
  // a mismatch.
  await options.page.keyboard.type(options.text, { delay: options.delayMs });
  return { strategy: "keyboard", verifiedValue: options.text };
}
