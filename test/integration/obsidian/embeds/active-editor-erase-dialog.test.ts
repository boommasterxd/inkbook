import { describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../../src/domain/store/public";
import { ActiveEditorActions } from "../../../../src/obsidian/embeds/active-editor/controller-actions";
import { ActiveEditorHistory } from "../../../../src/obsidian/embeds/active-editor/history";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import {
  selectedRectangle,
  createClipboardDocumentModel,
  createDeferredPreparation,
  createPreparedToken,
} from "./active-editor-clipboard-fixtures";

function eraseFixture(confirm?: (signal: AbortSignal) => Promise<boolean>) {
  const element = selectedRectangle();
  const store = new ElementStore([element]);
  const state = { attached: true, revision: 1 };
  const prepare = vi.fn(async () => ({
    status: "prepared" as const,
    token: createPreparedToken(),
  }));
  const commit = vi.fn(() => ({
    forward: { bands: { content: [], highlight: [] }, removeIds: [element.id] },
    payloadBytes: 1,
    reverse: { bands: { content: [element.id], highlight: [] } },
  }));
  const model = createClipboardDocumentModel({
    store,
    revision: () => state.revision,
    commitPreparedElementMutation: commit,
    planClipboardPaste: vi.fn(async () => null),
    prepareElementMutation: prepare,
  });
  const history = new ActiveEditorHistory(model);
  const setSelection = vi.fn();
  const feedback = vi.fn();
  const actions = new ActiveEditorActions({
    confirmEraseAll: confirm,
    currentSelection: () => new Set([element.id]),
    history,
    isAttached: () => state.attached,
    isEnabled: () => true,
    lastSessionPointer: () => null,
    model,
    onCopyEmbed: vi.fn(),
    onDeleteEmbed: vi.fn(),
    onFeedback: feedback,
    onPasteCommitted: vi.fn(),
    onPendingChanged: vi.fn(),
    onStateChanged: vi.fn(),
    ownerWindow: { navigator: {} } as Window,
    sceneStore: new ElementSceneStore(store),
    setSelection,
    visibleCenter: () => ({ x: 100, y: 100 }),
  });
  return { actions, commit, feedback, history, prepare, setSelection, state };
}

function pendingConfirmation() {
  let resolve = (_value: boolean): void => undefined;
  const promise = new Promise<boolean>((complete) => {
    resolve = complete;
  });
  return { confirm: vi.fn((_signal: AbortSignal) => promise), resolve };
}

describe("erase-all Obsidian confirmation", () => {
  it("waits for confirmation and records an undoable mutation", async () => {
    const pending = pendingConfirmation();
    const fixture = eraseFixture(pending.confirm);
    fixture.actions.execute("erase-all");
    fixture.actions.execute("erase-all");
    expect(pending.confirm).toHaveBeenCalledTimes(1);
    expect(fixture.prepare).not.toHaveBeenCalled();
    pending.resolve(true);
    await vi.waitFor(() => expect(fixture.commit).toHaveBeenCalledTimes(1));
    expect(fixture.setSelection).toHaveBeenCalledWith(new Set());
    expect(await fixture.history.undoAsync()).toBe(true);
    expect(fixture.commit).toHaveBeenCalledTimes(2);
    fixture.actions.dispose();
  });

  it("cancels a prepared erase when the presentation is disabled", async () => {
    const preparation = createDeferredPreparation();
    const fixture = eraseFixture(async () => true);
    fixture.prepare.mockImplementationOnce(() => preparation.promise);
    fixture.actions.execute("erase-all");
    await vi.waitFor(() => expect(fixture.prepare).toHaveBeenCalledOnce());
    fixture.actions.cancelPendingConfirmation();
    preparation.complete();
    await vi.waitFor(() => expect(fixture.feedback).toHaveBeenCalledWith("history-change-failed"));
    expect(fixture.commit).not.toHaveBeenCalled();
    fixture.actions.dispose();
  });

  it.each(["cancelled", "unavailable", "rejected"])("fails closed when %s", async (mode) => {
    const confirm =
      mode === "unavailable"
        ? undefined
        : vi.fn(async () => {
            if (mode === "rejected") throw new Error("Dialog failed");
            return false;
          });
    const fixture = eraseFixture(confirm);
    fixture.actions.execute("erase-all");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(fixture.prepare).not.toHaveBeenCalled();
    fixture.actions.dispose();
  });

  it.each(["disposed", "detached", "disabled", "revised"])(
    "rejects %s confirmations",
    async (mode) => {
      const pending = pendingConfirmation();
      const fixture = eraseFixture(pending.confirm);
      fixture.actions.execute("erase-all");
      if (mode === "disposed") fixture.actions.dispose();
      if (mode === "detached") fixture.state.attached = false;
      if (mode === "disabled") fixture.actions.cancelPendingConfirmation();
      if (mode === "revised") fixture.state.revision += 1;
      pending.resolve(true);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(fixture.prepare).not.toHaveBeenCalled();
      if (mode === "disposed" || mode === "disabled") {
        expect(pending.confirm.mock.calls[0]?.[0].aborted).toBe(true);
      }
      fixture.actions.dispose();
    },
  );
});
