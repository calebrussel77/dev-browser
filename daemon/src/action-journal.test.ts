import { describe, expect, it } from "vitest";
import { trustedInputError } from "./action-journal.js";

describe("trusted input error typing", () => {
  it("types detached or navigated frame failures", () => {
    const page = { isClosed: () => false } as never;
    expect(trustedInputError(new Error("Frame was detached during action"), page)).toMatchObject({ code: "FRAME_DETACHED", recoverable: true });
    expect(trustedInputError(new Error("Execution context was destroyed due to navigation"), page)).toMatchObject({ code: "FRAME_DETACHED", recoverable: true });
  });
});
