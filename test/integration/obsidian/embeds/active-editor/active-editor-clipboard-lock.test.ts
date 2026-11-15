// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
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
import { loadBuiltinFont } from "../../../../../src/persistence/fonts/builtin-fonts";
import {
  decodeCustomClipboardText,
  encodeRuntimeSelection,
} from "../../../../../src/persistence/clipboard/codec";
import { planPaste } from "../../../../../src/persistence/clipboard/operations";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/document-codec";
import { createTestStroke } from "../../../../fixtures/persistence/worker-snapshot";
import { imageElement } from "../../../../fixtures/domain/images";
import { rasterResource } from "../../../../fixtures/persistence/image-svg";
import {
  installNativeTextInkHost,
  nativeInkText,
} from "../../../../fixtures/obsidian/native-text-ink";
import type { FontResourceV2, InkElementV1 } from "../../../../../src/domain/schema/public";
import type { EditableDocumentModel } from "../../../../../src/obsidian/embeds/document-session/document-model-port";
import { parseInkbookDocumentForTest } from "../../../../fixtures/persistence/parse-document";

afterEach(() => vi.restoreAllMocks());

async function legacyTextPasteHarness(kind: "legacy" | "modern" | "stroke" = "legacy") {
  const scheduler = immediateWorkScheduler();
  const font = await loadBuiltinFont("inter", 400, "normal", scheduler);
  const source = kind === "stroke" ? createTestStroke() : nativeInkText(font);
  if (source.kind === "text" && kind === "modern")
    source.layout.lines[0]!.runs[0]!.inkBounds = { minX: -2, minY: -20, maxX: 48, maxY: 4 };
  const encoded = encodeRuntimeSelection([source], new Set([source.id]), [font]);
  if (!encoded.ok) throw new Error(encoded.error.message);
  const raster = rasterResource();
  const image = {
    ...imageElement(),
    assetId: raster.id,
    crop: { x: 0, y: 0, width: 1, height: 1 },
  };
  const store = new ElementStore([image]);
  let revision = 7;
  let fonts: readonly FontResourceV2[] = [];
  let planned: InkElementV1 | undefined;
  const model: EditableDocumentModel = {
    ...createClipboardDocumentModel({
      store,
      revision: () => revision,
      ...elementMutationPorts(store, () => {
        revision += 1;
      }),
      planClipboardPaste: async () => {
        const decoded = decodeCustomClipboardText(encoded.value.customText);
        if (!decoded.ok) throw new Error(decoded.error.message);
        const plan = planPaste({
          decoded: decoded.value,
          existingElements: [image],
          page: model.page,
          target: { x: 400, y: 300 },
          commandTimestamp: 1,
          createId: () => "00000000-0000-4000-8000-000000000999",
        });
        if (!plan.ok) throw new Error(plan.error.message);
        planned = plan.value.elements[0];
        fonts = plan.value.fontResources ?? [];
        if (fonts.length > 0) revision += 1;
        return plan.value;
      },
    }),
    get revision() {
      return revision;
    },
    get fontResources() {
      return fonts;
    },
  };
  const host = installNativeTextInkHost();
  const history = new ActiveEditorHistory(model);
  const controller = new ActiveEditorClipboardController({
    model,
    history,
    ownerWindow: window,
    workScheduler: scheduler,
    currentSelection: () => new Set(),
    isPresentationAttached: () => true,
    onPendingChanged: () => undefined,
    onResult: () => undefined,
    onSelectionChanged: () => undefined,
  });
  vi.spyOn(window.navigator, "clipboard", "get").mockReturnValue({
    read: async () => [
      { types: ["text/plain"], getType: async () => new Blob([encoded.value.plainText]) },
    ],
  } as unknown as Clipboard);
  return {
    controller,
    history,
    host,
    model,
    store,
    raster,
    encoded: encoded.value,
    planned: () => planned,
    dispose: () => {
      controller.dispose();
      history.dispose();
      host.dispose();
    },
  };
}

const pasteAtCenter = () => ({ kind: "toolbar" as const, visibleCanvasCenter: { x: 400, y: 300 } });

it("prepares legacy v2 clipboard text with its bound native face before append and v5 image export", async () => {
  const f = await legacyTextPasteHarness();
  try {
    expect(f.encoded.payload.version).toBe(2);
    expect(await f.controller.paste(pasteAtCenter())).toMatchObject({ kind: "committed" });
    const element = f.store.get("00000000-0000-4000-8000-000000000999")!.element;
    const planned = f.planned();
    if (element.kind !== "text" || planned?.kind !== "text")
      throw new Error("Expected pasted text.");
    expect({ ...element, layout: planned.layout }).toEqual(planned);
    expect(element.layout.lines[0]!.runs[0]!.inkBounds).toEqual({
      minX: -1.6,
      minY: -20,
      maxX: 48,
      maxY: 4,
    });
    const output = serializeInkbookDocument(
      f.store.materializeSnapshot({
        page: f.model.page,
        revision: f.model.revision,
        version: 5,
        fontResources: [...(f.model.fontResources ?? [])],
        imageResources: [f.raster],
      }),
    );
    expect(output.ok).toBe(true);
    if (output.ok) {
      const restored = await parseInkbookDocumentForTest(output.value.svg);
      expect(restored.ok).toBe(true);
      if (restored.ok) {
        expect(restored.value.snapshot.version).toBe(5);
        expect(restored.value.snapshot.elements.find(({ id }) => id === element.id)).toEqual(
          element,
        );
      }
    }
    expect(f.host.created).toHaveLength(1);
    expect(f.host.retained.size).toBe(0);
    expect(f.host.canvases[0]?.width).toBe(0);
    expect(f.model.revision).toBe(9);
    expect(f.history.commandCount).toBe(1);
  } finally {
    f.dispose();
  }
});

it("does not append when disposal interrupts legacy clipboard native font preparation", async () => {
  const f = await legacyTextPasteHarness();
  let release!: () => void;
  f.host.defer(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  try {
    const pending = f.controller.paste(pasteAtCenter());
    await vi.waitFor(() => expect(f.host.loading()).toBe(1));
    f.controller.dispose();
    release();
    expect(await pending).toMatchObject({ kind: "unavailable", reason: "stale-operation" });
    expect(f.store.size).toBe(1);
    expect(f.history.commandCount).toBe(0);
    expect(f.host.retained.size).toBe(0);
    expect(f.host.canvases).toHaveLength(0);
  } finally {
    release();
    f.dispose();
  }
});

it.each(["modern", "stroke"] as const)(
  "pastes %s clipboard elements without native font or canvas work",
  async (kind) => {
    const f = await legacyTextPasteHarness(kind);
    try {
      expect(await f.controller.paste(pasteAtCenter())).toMatchObject({ kind: "committed" });
      expect(f.store.size).toBe(2);
      expect(f.host.created).toHaveLength(0);
      expect(f.host.canvases).toHaveLength(0);
    } finally {
      f.dispose();
    }
  },
);

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
