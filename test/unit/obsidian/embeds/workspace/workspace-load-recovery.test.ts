import { describe, expect, it, vi } from "vitest";

import { handleWorkspaceActivationFailure } from "../../../../../src/obsidian/embeds/workspace/workspace-load-recovery";

describe("workspace activation failure", () => {
  it("refreshes the persisted preview and exposes version-change recovery", () => {
    const identity = { outputHash: "a".repeat(64), revision: 8 };
    const failAutoActivation = vi.fn();
    const refreshPreview = vi.fn();
    const setState = vi.fn();
    const showLoadError = vi.fn();

    handleWorkspaceActivationFailure(
      {
        actualSourceIdentity: identity,
        kind: "source-changed",
        sessionId: "session-1",
        token: 1,
      },
      { failAutoActivation, refreshPreview, setState, showLoadError },
    );

    expect(failAutoActivation).toHaveBeenCalledOnce();
    expect(refreshPreview).toHaveBeenCalledWith(identity);
    expect(setState).toHaveBeenCalledWith("load-error");
    expect(showLoadError).toHaveBeenCalledWith("drawing-version-changed");
  });

  it("returns cancellations to locked state without error recovery", () => {
    const setState = vi.fn();
    const showLoadError = vi.fn();

    handleWorkspaceActivationFailure(
      { kind: "cancelled", reason: "superseded", token: 1 },
      {
        failAutoActivation: vi.fn(),
        refreshPreview: vi.fn(),
        setState,
        showLoadError,
      },
    );

    expect(setState).toHaveBeenCalledWith("locked");
    expect(showLoadError).not.toHaveBeenCalled();
  });
});
