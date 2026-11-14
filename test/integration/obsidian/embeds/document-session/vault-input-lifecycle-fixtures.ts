import { expect, vi } from "vitest";
import { WorkspaceEditorCoordinator } from "../../../../../src/editor/session/workspace-editor-coordinator";
import type { EditableDocumentModel } from "../../../../../src/obsidian/embeds/document-session/document-model-port";
import { operation, persistenceHarness } from "./vault-session-fixtures";

type LifecycleHarness = ReturnType<typeof persistenceHarness>;

export function inputLifecycleCoordinator(
  harness: LifecycleHarness,
  release = vi.fn(),
  failed = vi.fn(),
) {
  const coordinator = new WorkspaceEditorCoordinator({
    createSessionId: () => "session-1",
    sessions: { create: () => harness.session },
    presentations: {
      cancelGesture: vi.fn(),
      disableInput: vi.fn(),
      release: () =>
        harness.factory.deferPresentationRelease(operation().documentId, release, failed),
    },
  });
  const target = {
    documentId: operation().documentId,
    attachmentId: "input-lifecycle",
    attachmentGeneration: 1,
  };
  coordinator.mountAttachment(target);
  return { coordinator, target, release, failed };
}

export function expectRetainedInput(harness: LifecycleHarness, model: EditableDocumentModel): void {
  expect(harness.session.documentModel).toBe(model);
  expect(harness.session.getSnapshot().dirty).toBe(true);
  expect(harness.process).not.toHaveBeenCalled();
}

export async function unlockedInputSession() {
  const harness = persistenceHarness();
  expect((await harness.session.unlock(operation())).status).toBe("active");
  return { harness, model: harness.session.documentModel! };
}
