import { expect, it, vi } from "vitest";
import { ElementStore, withElementLock } from "../../../../../src/domain/store/public";
import { ActiveEditorClipboardController } from "../../../../../src/obsidian/embeds/active-editor/controller-clipboard";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import { elementMutationPorts } from "../../../../fixtures/obsidian/element-mutation-ports";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import {
  ClipboardItemFixture,
  createClipboardDocumentModel,
  createEncodedClipboardFixture,
  selectedRectangle,
} from "./active-editor-clipboard-fixtures";

function clipboardHarness() {
  const editable = selectedRectangle();
  const locked = { ...editable, id: "00000000-0000-4000-8000-000000000002", locked: true };
  const store = new ElementStore([editable, locked]);
  let selection: ReadonlySet<string> = new Set([editable.id, locked.id]);
  const encode = vi.fn(async (_ids: ReadonlySet<string>) => createEncodedClipboardFixture());
  const model = createClipboardDocumentModel({
    ...elementMutationPorts(store, () => undefined),
    encodeClipboard: encode,
    planClipboardPaste: async () => null,
    store,
  });
  const history = new ActiveEditorHistory(model);
  const controller = new ActiveEditorClipboardController({
    currentSelection: () => selection,
    history,
    isPresentationAttached: () => true,
    model,
    onPendingChanged: () => undefined,
    onResult: () => undefined,
    onSelectionChanged: (next) => (selection = next),
    ownerWindow: {
      Blob,
      ClipboardItem: ClipboardItemFixture,
      navigator: { clipboard: { write: async () => undefined } },
    } as unknown as Window,
    workScheduler: immediateWorkScheduler(),
  });
  return { controller, editable, encode, history, locked, selection: () => selection, store };
}

it("copies the full mixed selection but cuts only editable elements and preserves their Undo", async () => {
  const harness = clipboardHarness();
  try {
    await expect(harness.controller.copy(harness.selection())).resolves.toMatchObject({
      action: "copy",
      kind: "copied",
    });
    expect(harness.encode.mock.calls[0]?.[0]).toEqual(
      new Set([harness.editable.id, harness.locked.id]),
    );
    await expect(harness.controller.cut(harness.selection())).resolves.toMatchObject({
      action: "cut",
      kind: "committed",
    });
    expect(harness.encode.mock.calls[1]?.[0]).toEqual(new Set([harness.editable.id]));
    expect(harness.store.get(harness.editable.id)).toBeUndefined();
    expect(harness.store.get(harness.locked.id)?.element).toEqual(harness.locked);
    expect(harness.selection()).toEqual(new Set([harness.locked.id]));
    await expect(harness.history.undoAsync()).resolves.toBe(true);
    expect(harness.store.get(harness.editable.id)?.element).toEqual(harness.editable);
    await expect(harness.history.redoAsync()).resolves.toBe(true);
    expect(harness.store.get(harness.editable.id)).toBeUndefined();
    expect(harness.store.get(harness.locked.id)?.element.locked).toBe(true);
    await expect(harness.controller.cut(harness.selection())).resolves.toMatchObject({
      action: "cut",
      kind: "unavailable",
      reason: "empty-selection",
    });
    expect(harness.encode).toHaveBeenCalledTimes(2);
  } finally {
    harness.controller.dispose();
    harness.history.dispose();
  }
});

it("does not remove an element locked while its clipboard payload is being prepared", async () => {
  const harness = clipboardHarness();
  try {
    harness.encode.mockImplementation(async () => {
      const current = harness.store.get(harness.editable.id)!.element;
      harness.store.replace(harness.editable.id, withElementLock(current, true));
      return createEncodedClipboardFixture();
    });
    await expect(harness.controller.cut(harness.selection())).resolves.toMatchObject({
      action: "cut",
      kind: "unavailable",
      reason: "stale-operation",
    });
    expect(harness.store.size).toBe(2);
    expect(harness.store.get(harness.editable.id)?.element.locked).toBe(true);
    expect(harness.history.commandCount).toBe(0);
  } finally {
    harness.controller.dispose();
    harness.history.dispose();
  }
});
