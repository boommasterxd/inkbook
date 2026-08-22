import { describe, expect, it, vi } from "vitest";

import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { createDragElement } from "../../../../src/editor/tools/public";
import { ActiveEditorActions } from "../../../../src/obsidian/embeds/active-editor/controller-actions";
import { ActiveEditorHistory } from "../../../../src/obsidian/embeds/active-editor/history";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/vault-document-session";
import {
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

function selectedRectangle(): InkElementV1 {
  return createDragElement({
    defaults: createBuiltInSettings().toolDefaults,
    end: { x: 200, y: 200 },
    identity: { createdAt: 1, id: "00000000-0000-4000-8000-000000000001" },
    start: { x: 100, y: 100 },
    tool: "rectangle",
  });
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
  const onNotice = vi.fn();
  const setSelection = vi.fn((next: ReadonlySet<string>) => {
    selection = next;
  });
  const write = vi.fn(async () => undefined);
  const actions = new ActiveEditorActions({
    currentSelection: () => selection,
    history,
    isEnabled: () => true,
    lastSessionPointer: () => null,
    model,
    onCopyEmbed: vi.fn(),
    onDeleteEmbed: vi.fn(),
    onNotice,
    onPasteCommitted: vi.fn(),
    onPendingChanged: vi.fn(),
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
    onNotice,
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

describe("active editor Cut notices", () => {
  it("reports a stale Cut without changing the replacement selection or copied payload", async () => {
    const fixture = cutFixture();
    const replacementSelection = new Set(["replacement-selection"]);

    fixture.actions.execute("cut");
    await vi.waitFor(() => expect(fixture.prepare).toHaveBeenCalledOnce());
    fixture.replaceSelection(replacementSelection);
    fixture.pending.complete();
    await vi.waitFor(() =>
      expect(fixture.onNotice).toHaveBeenCalledWith(
        "Copy succeeded, but Cut was cancelled because the selection changed.",
      ),
    );

    expect(fixture.write).toHaveBeenCalledOnce();
    expect(fixture.actions.canPaste).toBe(true);
    expect(fixture.selection()).toBe(replacementSelection);
    expect(fixture.setSelection).not.toHaveBeenCalled();
    expect(fixture.commit).not.toHaveBeenCalled();
    expect(fixture.history.commandCount).toBe(0);
    fixture.actions.dispose();
  });

  it("commits a current Cut without showing the stale-operation Notice", async () => {
    const fixture = cutFixture();

    fixture.actions.execute("cut");
    await vi.waitFor(() => expect(fixture.prepare).toHaveBeenCalledOnce());
    fixture.pending.complete();
    await vi.waitFor(() => expect(fixture.commit).toHaveBeenCalledOnce());

    expect(fixture.write).toHaveBeenCalledOnce();
    expect(fixture.onNotice).not.toHaveBeenCalled();
    expect(fixture.setSelection).toHaveBeenCalledWith(new Set());
    expect(fixture.selection()).toEqual(new Set());
    expect(fixture.history.commandCount).toBe(1);
    fixture.actions.dispose();
  });
});
