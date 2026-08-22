import { describe, expect, it } from "vitest";

import {
  createUnlockingState,
  reattachSession,
  replaceSessionAttachment,
  transitionSession,
  type AttachmentIdentity,
} from "../../../../src/editor/session/session-state";

const firstAttachment: AttachmentIdentity = {
  attachmentGeneration: 1,
  attachmentId: "first",
};
const secondAttachment: AttachmentIdentity = {
  attachmentGeneration: 2,
  attachmentId: "second",
};

describe("session state", () => {
  it("follows the attached editing lifecycle", () => {
    const unlocking = createUnlockingState(firstAttachment);
    const active = transitionSession(unlocking, "unlock-succeeded");
    const locking = transitionSession(active, "start-lock");
    const saveError = transitionSession(locking, "save-failed");
    const retrying = transitionSession(saveError, "retry-save");
    const locked = transitionSession(retrying, "save-confirmed");

    expect(active).toEqual({ attachment: firstAttachment, phase: "active" });
    expect(saveError.phase).toBe("save-error");
    expect(locked).toEqual({ phase: "locked" });
  });

  it("models detached saving and headless recovery without an attachment", () => {
    const active = transitionSession(createUnlockingState(firstAttachment), "unlock-succeeded");
    const detached = transitionSession(active, "detach-dirty");
    const headless = transitionSession(detached, "save-failed");

    expect(detached).toEqual({ phase: "detached-saving" });
    expect(headless).toEqual({ phase: "headless-recovery" });
    expect(transitionSession(headless, "retry-save")).toEqual({ phase: "detached-saving" });
    expect(reattachSession(headless, secondAttachment)).toEqual({
      attachment: secondAttachment,
      phase: "save-error",
    });
  });

  it("preserves the phase when handing an attached session to another presentation", () => {
    const active = transitionSession(createUnlockingState(firstAttachment), "unlock-succeeded");

    expect(replaceSessionAttachment(active, secondAttachment)).toEqual({
      attachment: secondAttachment,
      phase: "active",
    });
  });

  it("rejects transitions that would discard state", () => {
    const active = transitionSession(createUnlockingState(firstAttachment), "unlock-succeeded");

    expect(() => transitionSession(active, "unlock-succeeded")).toThrow(
      "Invalid session transition",
    );
    expect(() => reattachSession(active, secondAttachment)).toThrow("Cannot reattach");
    expect(() =>
      replaceSessionAttachment({ phase: "headless-recovery" }, secondAttachment),
    ).toThrow("Cannot replace");
  });

  it("always releases a session on plugin unload", () => {
    expect(transitionSession(createUnlockingState(firstAttachment), "plugin-unload")).toEqual({
      phase: "released",
    });
    expect(transitionSession({ phase: "headless-recovery" }, "plugin-unload")).toEqual({
      phase: "released",
    });
  });
});
