import { describe, expect, it, vi } from "vitest";

import { ActiveEditorBackgroundSession } from "../../../../src/obsidian/embeds/active-editor/background-session";
import { ActiveDocumentHistory } from "../../../../src/obsidian/embeds/active-editor/document-history";
import { ActiveEditorHistory } from "../../../../src/obsidian/embeds/active-editor/history";
import { DocumentRevisionExhaustedError } from "../../../../src/obsidian/embeds/document-model-port";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/vault-document-session";
import { parseInkbookDocument } from "../../../../src/persistence/serialization/public";
import { emptySnapshot, operation, persistenceHarness, rectangle } from "./vault-session-fixtures";

function requireModel(
  factory: ReturnType<typeof persistenceHarness>["factory"],
): EditableDocumentModel {
  const model = factory.getDocumentModel("session-1");
  if (model === undefined) throw new Error("Expected an editable document model.");
  return model;
}

function expectPersistedSnapshot(content: string) {
  const parsed = parseInkbookDocument(content);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("Expected a persisted Inkbook document.");
  return parsed.value.snapshot;
}

describe("vault-backed revision capacity", () => {
  it("rejects every persisted mutation entry before changing a max-revision document", async () => {
    const source = rectangle();
    const { factory, session } = persistenceHarness({
      ...emptySnapshot(),
      elements: [source],
      revision: Number.MAX_SAFE_INTEGER,
    });
    await session.unlock(operation());
    const model = requireModel(factory);
    const before = model.store.materializeSnapshot({ page: model.page, revision: model.revision });
    const deltas = vi.fn();
    const unsubscribe = model.store.subscribe(deltas);
    const replacement = { ...source, style: { ...source.style, outlineWidth: 8 as const } };
    const history = new ActiveEditorHistory(model);
    const documentHistory = new ActiveDocumentHistory({ history, model });

    expect(model.mutationAvailability).toBe("revision-exhausted");
    expect(() => model.commitElement({ ...source, id: source.id.replace(/1$/u, "2") })).toThrow(
      DocumentRevisionExhaustedError,
    );
    expect(() => model.replaceElements([replacement])).toThrow(DocumentRevisionExhaustedError);
    expect(() => model.removeElements([source.id])).toThrow(DocumentRevisionExhaustedError);
    await expect(documentHistory.remove([source.id])).resolves.toBe("failed");
    expect(history.commandCount).toBe(0);
    expect(() => model.arrangeElements(new Set([source.id]), "bring-to-front")).toThrow(
      DocumentRevisionExhaustedError,
    );
    expect(() =>
      model.commitBandOrder({
        content: model.store.materializeBandOrder("content"),
        highlight: model.store.materializeBandOrder("highlight"),
      }),
    ).toThrow(DocumentRevisionExhaustedError);
    expect(() =>
      model.commitPage({ ...model.page, activeBufferLines: model.page.activeBufferLines + 1 }),
    ).toThrow(DocumentRevisionExhaustedError);

    const preparedMutation = await model.prepareElementMutation(
      { bands: { content: [], highlight: [] }, removeIds: [source.id] },
      { isCancelled: () => false },
    );
    const mutationToken = preparedMutation.token;
    if (mutationToken === null) throw new Error("Expected a prepared element mutation.");
    expect(() => model.commitPreparedElementMutation(mutationToken)).toThrow(
      DocumentRevisionExhaustedError,
    );
    const preparedReplacement = await model.prepareElementReplacement([replacement], {
      isCancelled: () => false,
    });
    const replacementToken = preparedReplacement.token;
    if (replacementToken === null) {
      throw new Error("Expected a prepared element replacement.");
    }
    expect(() => model.commitPreparedElementReplacement(replacementToken)).toThrow(
      DocumentRevisionExhaustedError,
    );

    expect(model.store.materializeSnapshot({ page: model.page, revision: model.revision })).toEqual(
      before,
    );
    expect(session.getSnapshot()).toMatchObject({
      confirmedRevision: Number.MAX_SAFE_INTEGER,
      dirty: false,
      revision: Number.MAX_SAFE_INTEGER,
    });
    expect(deltas).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("active editor revision capacity", () => {
  it("persists max exactly and rejects the next commit without losing autosave identity", async () => {
    const { content, factory, process, session } = persistenceHarness({
      ...emptySnapshot(),
      revision: Number.MAX_SAFE_INTEGER - 1,
    });
    await session.unlock(operation());
    const model = requireModel(factory);
    const deltas = vi.fn();
    const unsubscribe = model.store.subscribe(deltas);

    model.commitElement(rectangle());
    expect(model.revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(model.mutationAvailability).toBe("revision-exhausted");
    expect(() => model.removeElements([rectangle().id])).toThrow(DocumentRevisionExhaustedError);
    expect(model.store.get(rectangle().id)).toBeDefined();
    expect(deltas).toHaveBeenCalledOnce();

    await expect(
      session.lockLatest({ ...operation(), operationId: 2, workspaceToken: 2 }),
    ).resolves.toMatchObject({ revision: Number.MAX_SAFE_INTEGER, status: "confirmed" });
    expect(process).toHaveBeenCalledOnce();
    expect(expectPersistedSnapshot(content())).toMatchObject({
      elements: [rectangle()],
      revision: Number.MAX_SAFE_INTEGER,
    });
    expect(session.getSnapshot()).toMatchObject({
      confirmedRevision: Number.MAX_SAFE_INTEGER,
      dirty: false,
      revision: Number.MAX_SAFE_INTEGER,
    });
    unsubscribe();
  });

  it("keeps background and history traversal unavailable at max revision", async () => {
    const { factory, session } = persistenceHarness({
      ...emptySnapshot(),
      revision: Number.MAX_SAFE_INTEGER - 2,
    });
    await session.unlock(operation());
    const model = requireModel(factory);
    const history = new ActiveEditorHistory(model);

    expect(history.create([rectangle()])).toBe(true);
    expect(history.undo()).toBe(true);
    expect(model.revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(model.store.size).toBe(0);
    expect(history.redo()).toBe(false);
    await expect(history.redoAsync()).resolves.toBe(false);
    expect(history.canRedo).toBe(true);

    const onPageChanged = vi.fn();
    const onPagePreview = vi.fn();
    const onStateChanged = vi.fn();
    const background = new ActiveEditorBackgroundSession({
      backgroundSpacing: () => ({ dots: 25, lines: 25, squares: 25 }),
      history,
      model,
      onPageChanged,
      onPagePreviewFinish: vi.fn(),
      onPagePreview,
      onStateChanged,
    });
    background.previewSpacing("xl");
    background.changeType("dots");
    expect(
      history.reorder({ content: [rectangle().id], highlight: [] }, { content: [], highlight: [] }),
    ).toBe(false);
    expect(
      history.replace(
        [rectangle()],
        [{ ...rectangle(), style: { ...rectangle().style, outlineWidth: 8 } }],
      ),
    ).toBe(false);
    expect(model.page).toEqual(emptySnapshot().page);
    expect(onPageChanged).not.toHaveBeenCalled();
    expect(onPagePreview).not.toHaveBeenCalled();
    expect(onStateChanged).not.toHaveBeenCalled();
    expect(history.commandCount).toBe(1);
  });
});
