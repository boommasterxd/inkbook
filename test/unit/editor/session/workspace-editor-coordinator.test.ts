import { describe, expect, it, vi } from "vitest";

import {
  activate,
  createHarness,
  documentA,
  documentASecondView,
  documentB,
  enterHeadlessRecovery,
} from "./workspace-editor-coordinator-fixture";

describe("WorkspaceEditorCoordinator", () => {
  it("locks the attached editor only after cancelling input and confirming its latest save", async () => {
    const harness = createHarness();
    const session = await activate(harness, documentA);

    expect(harness.coordinator.requestLockCurrent()).toBe(true);
    expect(harness.coordinator.getSnapshot().current?.phase).toBe("locking");
    expect(harness.cancelGesture).toHaveBeenCalledWith({
      attachmentGeneration: documentA.attachmentGeneration,
      attachmentId: documentA.attachmentId,
    });
    expect(harness.disableInput).toHaveBeenCalledWith({
      attachmentGeneration: documentA.attachmentGeneration,
      attachmentId: documentA.attachmentId,
    });
    expect(session.locks).toHaveLength(1);

    session.completeSave();
    await vi.waitFor(() => {
      expect(harness.release).toHaveBeenCalledOnce();
    });

    expect(session.disposed).toBe(true);
    expect(harness.coordinator.getSnapshot().current).toBeUndefined();
    expect(harness.coordinator.requestLockCurrent()).toBe(false);
  });
});

describe("WorkspaceEditorCoordinator activation", () => {
  it("hands one session to another presentation of the same document", async () => {
    const harness = createHarness();
    const session = await activate(harness, documentA);
    harness.coordinator.mountAttachment(documentASecondView);

    const handoff = harness.coordinator.requestActivation(documentASecondView);

    await expect(handoff.outcome).resolves.toMatchObject({
      disposition: "same-document-handoff",
      kind: "activated",
      sessionId: session.snapshot.sessionId,
    });
    expect(harness.sessions).toHaveLength(1);
    expect(harness.cancelGesture).toHaveBeenCalledWith({
      attachmentGeneration: 1,
      attachmentId: "attachment-a",
    });
    expect(harness.release).toHaveBeenCalledOnce();
  });
});

describe("WorkspaceEditorCoordinator detached ownership", () => {
  it("keeps failed detached saves in headless recovery and blocks other documents", async () => {
    const harness = createHarness();
    await enterHeadlessRecovery(harness);

    expect(harness.coordinator.getSnapshot().current?.phase).toBe("headless-recovery");
    expect(harness.headlessRecoveryRequired).toHaveBeenCalledOnce();
    harness.coordinator.mountAttachment(documentB);
    const blocked = harness.coordinator.requestActivation(documentB);
    expect(harness.coordinator.getSnapshot().pending?.token).toBe(blocked.token);
    expect(harness.sessions).toHaveLength(1);

    harness.coordinator.mountAttachment(documentASecondView);
    const recovery = harness.coordinator.requestActivation(documentASecondView);
    await expect(blocked.outcome).resolves.toMatchObject({ reason: "superseded" });
    await expect(recovery.outcome).resolves.toMatchObject({ phase: "save-error" });
  });
});
