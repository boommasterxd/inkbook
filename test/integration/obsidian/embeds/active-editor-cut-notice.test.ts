import { describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../../src/domain/store/public";
import { ActiveEditorActions } from "../../../../src/obsidian/embeds/active-editor/controller-actions";
import { ActiveEditorHistory } from "../../../../src/obsidian/embeds/active-editor/history";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/vault-document-session";
import {
  selectedRectangle,
  createClipboardDocumentModel,
  createDeferredPreparation,
  createEncodedClipboardFixture,
} from "./active-editor-clipboard-fixtures";

class FakeClipboardItem {
  public constructor(readonly formats: Record<string, Promise<Blob>>) {}
}

function clipboardWindow(write: Clipboard["write"]): Window {
  return {
    Blob,
    ClipboardItem: FakeClipboardItem,
    navigator: { clipboard: { write } },
  } as unknown as Window;
}

function cutFixture() {
  const selected = selectedRectangle();
  const store = new ElementStore([selected]);
  const pending = createDeferredPreparation();
  const commit = vi.fn(() => ({
    forward: { bands: { content: [], highlight: [] } },
    payloadBytes: 1,
    reverse: { bands: { content: [selected.id], highlight: [] } },
  }));
  const prepare = vi.fn(() => pending.promise);
  const model = createClipboardDocumentModel({
    store,
    commitPreparedElementMutation: commit,
    encodeClipboard: vi.fn(async () => createEncodedClipboardFixture()),
    planClipboardPaste: vi.fn(async () => null),
    prepareElementMutation: prepare,
  });
  return actionFixture(model, selected.id, pending, prepare, commit);
}

function actionFixture(
  model: EditableDocumentModel,
  selectedId: string,
  pending: ReturnType<typeof createDeferredPreparation>,
  prepare: ReturnType<typeof vi.fn>,
  commit: ReturnType<typeof vi.fn>,
) {
  let selection: ReadonlySet<string> = new Set([selectedId]);
  const history = new ActiveEditorHistory(model);
  const onFeedback = vi.fn();
  const setSelection = vi.fn((next: ReadonlySet<string>) => {
    selection = next;
  });
  const write = vi.fn(async () => undefined);
  let enabled = true;
  const actions = new ActiveEditorActions({
    renderer: { setElementFade: vi.fn(), clearElementFade: vi.fn() },
    currentSelection: () => selection,
    history,
    isAttached: () => true,
    isEnabled: () => enabled,
    lastSessionPointer: () => null,
    model,
    onCopyEmbed: vi.fn(),
    onDeleteEmbed: vi.fn(),
    onFeedback,
    onPasteCommitted: vi.fn(),
    onPendingChanged: (pending) => {
      enabled = !pending;
    },
    onStateChanged: vi.fn(),
    ownerWindow: clipboardWindow(write),
    sceneStore: new ElementSceneStore(model.store),
    setSelection,
    visibleCenter: () => ({ x: 100, y: 100 }),
  });
  return {
    actions,
    commit,
    history,
    onFeedback,
    pending,
    prepare,
    replaceSelection: (next: ReadonlySet<string>) => {
      selection = next;
    },
    selection: () => selection,
    setSelection,
    write,
  };
}

async function commitRemoval(
  fixture: ReturnType<typeof cutFixture>,
  action: "cut" | "delete",
): Promise<void> {
  fixture.actions.execute(action);
  await vi.waitFor(() => expect(fixture.prepare).toHaveBeenCalledOnce());
  fixture.pending.complete();
  await vi.waitFor(() => expect(fixture.commit).toHaveBeenCalledOnce());
  expect(fixture.setSelection).toHaveBeenCalledWith(new Set());
  expect(fixture.selection()).toEqual(new Set());
  expect(fixture.history.commandCount).toBe(1);
}

describe("active editor Clipboard busy feedback", () => {
  it("reports repeated input instead of silently dropping it", async () => {
    const fixture = cutFixture();

    fixture.actions.execute("cut");
    fixture.actions.execute("copy");
    expect(fixture.actions.pasteFromClipboardData(null)).toBe(true);

    expect(fixture.onFeedback.mock.calls).toEqual([
      ["clipboard-operation-busy"],
      ["clipboard-operation-busy"],
    ]);
    await vi.waitFor(() => expect(fixture.prepare).toHaveBeenCalledOnce());
    fixture.pending.complete();
    await vi.waitFor(() => expect(fixture.commit).toHaveBeenCalledOnce());
    fixture.actions.dispose();
  });
});

describe("active editor Cut feedback", () => {
  it("publishes and refreshes one transient toolbar confirmation for every successful Copy", async () => {
    const fixture = cutFixture();

    fixture.actions.execute("copy");
    await vi.waitFor(() => {
      expect(fixture.actions.actionConfirmation).toMatchObject({
        action: "copy",
        sequence: 1,
      });
      expect(fixture.actions.pasteVisible).toBe(true);
      expect(fixture.actions.isAvailable("copy")).toBe(true);
    });
    fixture.actions.execute("copy");
    expect(fixture.actions.pasteVisible).toBe(true);
    expect(fixture.actions.canPaste).toBe(false);
    await vi.waitFor(() =>
      expect(fixture.actions.actionConfirmation).toMatchObject({
        action: "copy",
        sequence: 2,
      }),
    );

    fixture.actions.dispose();
  });

  it("deletes the current selection as one history command", async () => {
    const fixture = cutFixture();

    await commitRemoval(fixture, "delete");

    expect(fixture.write).not.toHaveBeenCalled();
    fixture.actions.dispose();
  });

  it("reports a stale Cut without changing the replacement selection or copied payload", async () => {
    const fixture = cutFixture();
    const replacementSelection = new Set(["replacement-selection"]);

    fixture.actions.execute("cut");
    await vi.waitFor(() => expect(fixture.prepare).toHaveBeenCalledOnce());
    fixture.replaceSelection(replacementSelection);
    fixture.pending.complete();
    await vi.waitFor(() =>
      expect(fixture.onFeedback).toHaveBeenCalledWith("cut-selection-changed"),
    );

    expect(fixture.write).toHaveBeenCalledOnce();
    expect(fixture.actions.canPaste).toBe(true);
    expect(fixture.selection()).toBe(replacementSelection);
    expect(fixture.setSelection).not.toHaveBeenCalled();
    expect(fixture.commit).not.toHaveBeenCalled();
    expect(fixture.history.commandCount).toBe(0);
    fixture.actions.dispose();
  });

  it("commits a current Cut without showing stale-operation feedback", async () => {
    const fixture = cutFixture();

    await commitRemoval(fixture, "cut");

    expect(fixture.write).toHaveBeenCalledOnce();
    expect(fixture.actions.actionConfirmation).toMatchObject({ action: "cut" });
    expect(fixture.onFeedback).not.toHaveBeenCalled();
    fixture.actions.dispose();
  });

  it("reports a real standard system clipboard rejection while retaining in-session paste", async () => {
    const fixture = cutFixture();
    fixture.write.mockRejectedValue(new Error("permission denied"));

    fixture.actions.execute("copy");
    await vi.waitFor(() => expect(fixture.write).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(fixture.actions.canPaste).toBe(true));
    fixture.actions.execute("copy");
    await vi.waitFor(() => expect(fixture.write).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(fixture.actions.canPaste).toBe(true));

    expect(fixture.selection().size).toBe(1);
    expect(fixture.onFeedback).toHaveBeenCalledTimes(2);
    expect(fixture.onFeedback).toHaveBeenNthCalledWith(1, "clipboard-copy-fallback");
    expect(fixture.onFeedback).toHaveBeenNthCalledWith(2, "clipboard-copy-fallback");
    fixture.actions.dispose();
  });
});
