import { describe, expect, it, vi } from "vitest";
import {
  CANONICAL_THEME_STYLESHEET,
  LEGACY_THEME_STYLESHEET_V1,
} from "../../../../src/persistence/documents/svg-theme";

import {
  documentFromSnapshot,
  createReadOnlyVaultSession,
  emptySnapshot,
  operation,
  persistenceHarness,
  rectangle,
} from "./vault-session-fixtures";

describe("vault session save status", () => {
  it("shows pending immediately for a legacy palette that still requires its canonical rewrite", async () => {
    const svg = documentFromSnapshot().svg.replace(
      CANONICAL_THEME_STYLESHEET,
      LEGACY_THEME_STYLESHEET_V1,
    );
    const { factory, session } = createReadOnlyVaultSession({
      bytes: new TextEncoder().encode(svg),
      svg,
    });
    await session.unlock(operation());
    expect(factory.getDocumentModel("session-1")!.getSaveStatus!()).toBe("pending");
    session.dispose();
  });

  it("coalesces edit notifications and confirms only the latest queued revision", async () => {
    const harness = persistenceHarness();
    const { factory, process, session } = harness;
    await session.unlock(operation());
    const model = factory.getDocumentModel("session-1")!;
    const statuses: unknown[] = [];
    const unsubscribe = model.subscribeSaveStatus!(() => statuses.push(model.getSaveStatus!()));
    expect(model.getSaveStatus!()).toBe("saved");
    model.commitElement(rectangle());
    model.commitElement({ ...rectangle(), id: "00000000-0000-4000-8000-000000000002" });
    expect(statuses).toEqual(["pending"]);
    const releaseOlder = harness.holdProcess();
    const saving = session.lockLatest(operation());
    await vi.waitFor(() => expect(process).toHaveBeenCalledOnce());
    expect(model.getSaveStatus!()).toBe("saving");

    model.commitElement({ ...rectangle(), id: "00000000-0000-4000-8000-000000000003" });
    const releaseLatest = harness.holdProcess();
    releaseOlder();
    await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(2));
    expect(model.getSaveStatus!()).toBe("saving");
    expect(statuses).not.toContain("saved");
    releaseLatest();
    await expect(saving).resolves.toMatchObject({ revision: model.revision, status: "confirmed" });
    expect(model.getSaveStatus!()).toBe("saved");
    expect(statuses).toEqual(["pending", "saving", "pending", "saving", "saved"]);
    unsubscribe();
    model.commitElement({ ...rectangle(), id: "00000000-0000-4000-8000-000000000004" });
    session.dispose();
    expect(statuses).toHaveLength(5);
  });
});

describe("vault session save status recovery and lifecycle", () => {
  it("retains conflicts during continued edits and replaces failed state after external recovery", async () => {
    const { factory, replaceExternal, session } = persistenceHarness();
    await session.unlock(operation());
    const model = factory.getDocumentModel("session-1")!;
    model.commitElement(rectangle());
    const statuses: unknown[] = [];
    model.subscribeSaveStatus!(() => statuses.push(model.getSaveStatus!()));
    replaceExternal(documentFromSnapshot({ ...emptySnapshot(), revision: 20 }));
    await expect(session.notifyExternalChange()).resolves.toBe("conflict");
    expect(model.getSaveStatus!()).toBe("failed");
    model.commitElement({ ...rectangle(), id: "00000000-0000-4000-8000-000000000002" });
    expect(statuses).toEqual(["failed"]);
    await expect(session.lockLatest(operation())).resolves.toMatchObject({ status: "failed" });
    await expect(
      session.resolveRecovery("reload-external", { ...operation(), baseRevision: model.revision }),
    ).resolves.toMatchObject({ status: "confirmed" });
    const recovered = factory.getDocumentModel("session-1")!;
    expect(recovered).not.toBe(model);
    expect(recovered.getSaveStatus!()).toBe("saved");
    session.dispose();
    expect(statuses[statuses.length - 1]).toBe("saved");
  });

  it("keeps state and subscriptions with their own document session across attachment replacement", async () => {
    const first = persistenceHarness();
    const second = persistenceHarness();
    await Promise.all([first.session.unlock(operation()), second.session.unlock(operation())]);
    const previous = first.factory.getEditorContext("session-1")!.model;
    const other = second.factory.getEditorContext("session-1")!.model;
    const detachedListener = vi.fn();
    const detach = previous.subscribeSaveStatus!(detachedListener);
    previous.commitElement(rectangle());
    detach();
    const reattached = first.factory.getEditorContext("session-1")!.model;
    expect(reattached).toBe(previous);
    expect(reattached.getSaveStatus!()).toBe("pending");
    expect(other.getSaveStatus!()).toBe("saved");
    await first.session.lockLatest(operation());
    expect(detachedListener).toHaveBeenCalledOnce();
    expect(reattached.getSaveStatus!()).toBe("saved");
    first.session.dispose();
    second.session.dispose();
  });

  it("does not publish a save failure when replacing a clean external revision", async () => {
    const { factory, replaceExternal, session } = persistenceHarness();
    await session.unlock(operation());
    const model = factory.getDocumentModel("session-1")!;
    const listener = vi.fn();
    model.subscribeSaveStatus!(listener);
    replaceExternal(documentFromSnapshot({ ...emptySnapshot(), revision: 20 }));
    await expect(session.notifyExternalChange(operation())).resolves.toBe("reloaded");
    expect(factory.getDocumentModel("session-1")!.getSaveStatus!()).toBe("saved");
    expect(listener).not.toHaveBeenCalled();
    session.dispose();
  });

  it("does not claim saved when an external revision still requires adoption", async () => {
    const { factory, replaceExternal, session } = persistenceHarness();
    await session.unlock(operation());
    const model = factory.getDocumentModel("session-1")!;
    replaceExternal(documentFromSnapshot({ ...emptySnapshot(), revision: 20 }));
    await expect(session.notifyExternalChange()).resolves.toBe("reload-required");
    expect(model.getSaveStatus!()).toBe("pending");
    session.dispose();
  });

  it("keeps an unconfirmed vault write visibly failed while further edits are retained", async () => {
    const { factory, process, session } = persistenceHarness();
    await session.unlock(operation());
    const model = factory.getDocumentModel("session-1")!;
    model.commitElement(rectangle());
    process.mockRejectedValueOnce(new Error("Vault write failed"));
    await expect(session.lockLatest(operation())).resolves.toMatchObject({ status: "failed" });
    expect(model.getSaveStatus!()).toBe("failed");
    model.commitElement({ ...rectangle(), id: "00000000-0000-4000-8000-000000000002" });
    expect(model.getSaveStatus!()).toBe("failed");
    expect(model.store.size).toBe(2);
    session.dispose();
  });
});
