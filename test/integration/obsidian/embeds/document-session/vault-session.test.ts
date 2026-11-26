import { parseInkbookDocumentForTest } from "../../../../fixtures/persistence/parse-document";
import type { TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import type {
  AppliedElementMutation,
  ElementMutation,
} from "../../../../../src/domain/store/public";
import { ActiveEditorClipboardController } from "../../../../../src/obsidian/embeds/active-editor/controller-clipboard";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import type { EditableDocumentModel } from "../../../../../src/obsidian/embeds/document-session/vault-document-session";
import type { PastePlan } from "../../../../../src/persistence/clipboard/public";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/public";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { rasterImage, rasterResource } from "../../../../fixtures/persistence/image-svg";
import { ClipboardItemFixture } from "../active-editor/active-editor-clipboard-fixtures";

import {
  emptySnapshot,
  createVaultSessionFactory,
  operation,
  persistenceHarness,
  rectangle,
  TestTFile,
} from "./vault-session-fixtures";

async function applyElementMutation(
  model: EditableDocumentModel,
  mutation: ElementMutation,
): Promise<AppliedElementMutation | null> {
  const prepared = await model.prepareElementMutation(mutation, { isCancelled: () => false });
  return prepared.token === null ? null : model.commitPreparedElementMutation(prepared.token);
}

function sessionHarness(file: TFile, readBinary: unknown) {
  const factory = createVaultSessionFactory({ getFileByPath: () => file, readBinary });
  const session = factory.create({ documentId: file.path, sessionId: "session-1" });
  return { factory, session };
}

describe("vault-backed document session", () => {
  it("does not adopt a fully valid file that changed after the visible preview", async () => {
    const snapshot = emptySnapshot();
    const serialized = serializeInkbookDocument(snapshot);
    if (!serialized.ok) throw new Error("The test SVG could not be serialized.");
    const bytes = new TextEncoder().encode(serialized.value.svg);
    const file = new TestTFile("drawings/ink.svg", bytes.byteLength);
    const { factory, session } = sessionHarness(file, async () => bytes.buffer.slice(0));

    await expect(
      session.unlock({
        ...operation(),
        expectedSourceIdentity: { outputHash: "a".repeat(64), revision: snapshot.revision - 1 },
      }),
    ).resolves.toMatchObject({
      actualSourceIdentity: {
        outputHash: serialized.value.hash,
        revision: snapshot.revision,
      },
      status: "source-changed",
    });
    expect(factory.getDocumentModel("session-1")).toBeUndefined();
  });

  it("keeps unload persistence alive through delayed read-back before terminal disposal", async () => {
    const { content, factory, holdProcess, process, session } = persistenceHarness();
    await session.unlock(operation());
    factory.getDocumentModel("session-1")?.commitElement(rectangle());
    const releaseProcess = holdProcess();

    const unload = session.prepareForUnload();
    expect(factory.getDocumentModel("session-1")).toBeUndefined();
    await vi.waitFor(() => expect(process).toHaveBeenCalledOnce());
    releaseProcess();
    await unload;
    const parsed = await parseInkbookDocumentForTest(content());
    expect(parsed.ok && parsed.value.snapshot.revision).toBe(8);
  });

  it("rejects an oversized file before reading bytes", async () => {
    const file = new TestTFile("drawings/ink.svg", 64 * 1024 * 1024 + 1);
    const readBinary = vi.fn();
    const { session } = sessionHarness(file, readBinary);

    await expect(session.unlock(operation())).resolves.toMatchObject({ status: "load-error" });
    expect(readBinary).not.toHaveBeenCalled();
  });
});

describe("vault-backed document persistence", () => {
  it("applies cut and paste as reversible single-revision mutations", async () => {
    const { factory, session } = persistenceHarness();
    await session.unlock(operation());
    const model = factory.getDocumentModel("session-1");
    if (model === undefined) throw new Error("Expected an editable document model.");
    const source = rectangle();
    model.commitElement(source);
    const record = model.store.get(source.id);
    if (record === undefined) throw new Error("Expected the committed source element.");

    const cut = await applyElementMutation(model, {
      bands: { image: [], content: [], highlight: [] },
      removeIds: [record.element.id],
    });
    expect(cut).not.toBeNull();
    expect(model.store.size).toBe(0);
    expect(model.revision).toBe(9);
    if (cut === null) throw new Error("Expected an applied cut mutation.");
    expect(await applyElementMutation(model, cut.reverse)).not.toBeNull();
    expect(model.store.size).toBe(1);
    expect(model.revision).toBe(10);

    const pasted = { ...source, id: "00000000-0000-4000-8000-000000000002" };
    const plan: PastePlan = {
      activateTool: "select",
      commandTimestamp: 2,
      contentIds: [pasted.id],
      elements: [pasted],
      highlightIds: [],
      insertAtBandFront: true,
      repeatState: { fingerprint: "test", pasteCount: 1 },
      selectedIds: [pasted.id],
      translation: { x: 0, y: 0 },
    };
    const paste = await applyElementMutation(model, {
      bands: { image: [], content: [source.id, ...plan.contentIds], highlight: plan.highlightIds },
      elements: plan.elements,
    });
    expect(paste).not.toBeNull();
    expect(model.store.size).toBe(2);
    expect(model.revision).toBe(11);
    if (paste === null) throw new Error("Expected an applied paste mutation.");
    expect(await applyElementMutation(model, paste.reverse)).not.toBeNull();
    expect(model.store.size).toBe(1);
    expect(model.revision).toBe(12);
    expect(await applyElementMutation(model, paste.forward)).not.toBeNull();
    expect(model.store.size).toBe(2);
    expect(model.revision).toBe(13);
    session.dispose();
  });
});

it("copies a cropped image between drawings and saves its original raster bytes in the target", async () => {
  const resource = rasterResource();
  const crop = { x: 0.25, y: 0, width: 0.5, height: 1 };
  const image = rasterImage(resource, { crop });
  const source = persistenceHarness({
    ...emptySnapshot(),
    version: 5,
    elements: [image],
    imageResources: [resource],
  });
  const target = persistenceHarness();
  let clipboardItems: ClipboardItemFixture[] = [];
  const ownerWindow = {
    Blob,
    ClipboardItem: ClipboardItemFixture,
    navigator: {
      clipboard: {
        read: async () => clipboardItems,
        write: async (items: ClipboardItemFixture[]) => {
          clipboardItems = items;
        },
      },
    },
  } as unknown as Window;
  const createController = (model: EditableDocumentModel, selection: ReadonlySet<string>) =>
    new ActiveEditorClipboardController({
      currentSelection: () => selection,
      history: new ActiveEditorHistory(model),
      isPresentationAttached: () => true,
      model,
      onPendingChanged: () => undefined,
      onResult: () => undefined,
      onSelectionChanged: () => undefined,
      ownerWindow,
      workScheduler: immediateWorkScheduler(),
    });
  try {
    expect((await source.session.unlock(operation())).status).toBe("active");
    expect((await target.session.unlock(operation())).status).toBe("active");
    const selection = new Set([image.id]);
    const copy = createController(source.session.documentModel!, selection);
    const paste = createController(target.session.documentModel!, new Set());
    try {
      await expect(copy.copy(selection)).resolves.toEqual({ action: "copy", kind: "copied" });
      await expect(
        paste.paste({ kind: "toolbar", visibleCanvasCenter: { x: 300, y: 300 } }),
      ).resolves.toEqual({ action: "paste", kind: "committed" });
      expect((await target.session.lockLatest(operation())).status).toBe("confirmed");
      const saved = await parseInkbookDocumentForTest(target.content());
      if (!saved.ok) throw new Error(saved.error.message);
      const snapshot = saved.value.snapshot;
      expect(snapshot.imageResources).toEqual([resource]);
      expect(snapshot.elements).toMatchObject([{ kind: "image", assetId: resource.id, crop }]);
      expect(snapshot.elements[0]?.id).not.toBe(image.id);
    } finally {
      copy.dispose();
      paste.dispose();
    }
  } finally {
    source.session.dispose();
    target.session.dispose();
  }
});

describe("vault-backed document save verification", () => {
  it("exports an editor commit, processes the exact base, and validates read-back", async () => {
    const { content, factory, process, session } = persistenceHarness();
    await session.unlock(operation());

    const model = factory.getDocumentModel("session-1");
    model?.commitElement(rectangle());
    const encoded = await model?.encodeClipboard(new Set([rectangle().id]));
    expect(encoded?.customText).toContain("inkbook-elements");
    expect(process).not.toHaveBeenCalled();
    if (encoded === null || encoded === undefined) throw new Error("Clipboard encoding failed.");
    const paste = await model?.planClipboardPaste(
      { customText: encoded.customText },
      { kind: "toolbar", visibleCanvasCenter: { x: 500, y: 500 } },
    );
    expect(paste).not.toBeNull();
    if (paste === null || paste === undefined) throw new Error("Clipboard paste planning failed.");
    if (model === undefined) throw new Error("Expected an editable document model.");
    expect(
      await applyElementMutation(model, {
        bands: {
          image: [],
          content: [rectangle().id, ...paste.contentIds],
          highlight: paste.highlightIds,
        },
        elements: paste.elements,
      }),
    ).not.toBeNull();
    await expect(
      session.lockLatest({ ...operation(), operationId: 2, workspaceToken: 2 }),
    ).resolves.toMatchObject({ revision: 9, status: "confirmed" });

    expect(process).toHaveBeenCalledOnce();
    const parsed = await parseInkbookDocumentForTest(content());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.snapshot.revision).toBe(9);
      expect(parsed.value.snapshot.elements).toHaveLength(2);
      expect(parsed.value.snapshot.elements[0]).toEqual(rectangle());
    }
    expect(session.getSnapshot()).toMatchObject({ confirmedRevision: 9, dirty: false });
  });
});

describe("vault-backed recovery copies", () => {
  it("exports and verifies a recoverable local copy without replacing the conflicted file", async () => {
    const { createdCopies, factory, process, session } = persistenceHarness();
    await session.unlock(operation());
    factory.getDocumentModel("session-1")?.commitElement(rectangle());

    await expect(
      session.resolveRecovery("save-local-copy", {
        ...operation(),
        baseRevision: 8,
        operationId: 2,
      }),
    ).resolves.toMatchObject({
      savedPath: "drawings/ink-recovered-1.svg",
      status: "confirmed",
    });

    expect(process).not.toHaveBeenCalled();
    const saved = createdCopies.get("drawings/ink-recovered-1.svg")?.text;
    expect(saved).toBeDefined();
    const parsed = await parseInkbookDocumentForTest(saved ?? "");
    expect(parsed.ok && parsed.value.snapshot.elements).toEqual([rectangle()]);
  });

  it("preserves an unverified artifact when read-back cannot prove its original bytes", async () => {
    const { corruptCopyReads, createdCopies, factory, session } = persistenceHarness();
    await session.unlock(operation());
    const model = factory.getDocumentModel("session-1")!;
    model.commitElement(rectangle());
    corruptCopyReads();

    await expect(
      session.resolveRecovery("save-local-copy", {
        ...operation(),
        baseRevision: 8,
        operationId: 2,
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(createdCopies.has("drawings/ink-recovered-1.svg")).toBe(true);
    expect(factory.getDocumentModel("session-1")).toBe(model);
    expect(session.getSnapshot()).toMatchObject({ dirty: true, revision: 8 });
  });
});
