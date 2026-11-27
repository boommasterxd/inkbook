// @vitest-environment happy-dom

import { EditorState, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField, TFile, type Vault } from "obsidian";
import { expect, it, vi } from "vitest";

import { createLivePreviewExtension } from "../../../../../src/obsidian/embeds/live-preview/live-preview";
import type { EmbedIntegrationPorts } from "../../../../../src/obsidian/embeds/presentation/presentation-port";
import { ObsidianInkbookDocumentRecognition } from "../../../../../src/obsidian/embeds/preview/document-recognition";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/public";
import { configureTestEditorState } from "../../../../adapters/obsidian/plugin";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { createWorkerSnapshot } from "../../../../fixtures/persistence/worker-snapshot";

const syntax = vi.hoisted(() => ({ iterate: () => undefined }));
vi.mock("@codemirror/language", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@codemirror/language")>()),
  syntaxTree: () => syntax,
  syntaxTreeAvailable: () => true,
}));

class NativeImage extends WidgetType {
  override toDOM(): HTMLElement {
    return document.createElement("img");
  }
}

function fixture(source: string, range: { readonly from: number; readonly to: number }) {
  configureTestEditorState({ file: { path: "note.md" }, livePreview: true });
  const recognize = vi.fn(async () => false as const);
  const cached = vi.fn(() => undefined);
  const ports = {
    documents: { cached, recognize, subscribe: () => () => undefined },
    resolveDocument: (documentId: string) => ({ documentId, resourceUrl: `app://${documentId}` }),
  } as unknown as EmbedIntegrationPorts;
  const hostReplacement = StateField.define({
    create: () =>
      Decoration.set([
        Decoration.replace({ block: true, widget: new NativeImage() }).range(range.from, range.to),
      ]),
    update: (value) => value,
    provide: (field) => EditorView.decorations.from(field),
  });
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: source,
      extensions: [
        editorInfoField,
        editorLivePreviewField,
        hostReplacement,
        createLivePreviewExtension(ports),
      ],
    }),
  });
  return {
    cached,
    recognize,
    view,
    dispose: () => {
      view.destroy();
      parent.remove();
    },
  };
}

it("recognizes a native image whose block replacement hides its complete source range", () => {
  const embed = "![[new-handwriting-document.svg]]";
  const from = "Before\n\n".length;
  const h = fixture(`Before\n\n${embed}\nAfter`, { from, to: from + embed.length });
  try {
    expect(
      h.view.visibleRanges.some((range) => range.from <= from && range.to >= from + embed.length),
    ).toBe(false);
    expect(h.recognize).toHaveBeenCalledExactlyOnceWith(
      "new-handwriting-document.svg",
      h.view.dom.ownerDocument.defaultView,
    );
  } finally {
    h.dispose();
  }
});

it("does not decorate cached native previews inside a fence with a tab-indented marker", () => {
  configureTestEditorState({ file: { path: "note.md" }, livePreview: true });
  const visible = "![[visible.svg]]";
  const source = `\`\`\`md\n\t\`\`\`\n![[hidden.svg]]\n\`\`\`\n${visible}`;
  const ports = {
    documents: {
      cached: () => ({ safeSvg: "<svg/>", contentIdentity: { revision: 1, outputHash: "a" } }),
    },
    resolveDocument: (documentId: string) => ({ documentId, resourceUrl: `app://${documentId}` }),
  } as unknown as EmbedIntegrationPorts;
  const state = EditorState.create({
    doc: source,
    extensions: [editorInfoField, editorLivePreviewField, createLivePreviewExtension(ports)],
  });
  const replacements: Array<{ readonly from: number; readonly to: number }> = [];
  (state.facet(EditorView.decorations)[0] as DecorationSet).between(
    0,
    state.doc.length,
    (from, to) => {
      replacements.push({ from, to });
    },
  );
  expect(replacements).toEqual([{ from: source.indexOf(visible), to: source.length }]);
});

it("rejects a superseded preview read without disturbing the current validated revision", async () => {
  const first = serializeInkbookDocument(createWorkerSnapshot([], 1));
  const next = serializeInkbookDocument(createWorkerSnapshot([], 2));
  if (!first.ok || !next.ok) throw new Error("The preview fixtures could not be serialized.");
  const TestFile = TFile as unknown as new (path: string, size: number) => TFile;
  const file = new TestFile("drawing.svg", next.value.totalBytes);
  const cachedRead = vi
    .fn()
    .mockResolvedValueOnce(first.value.svg)
    .mockResolvedValue(next.value.svg);
  const vault = { getFileByPath: () => file, cachedRead } as unknown as Vault;
  const documents = new ObsidianInkbookDocumentRecognition(vault, {
    workScheduler: () => immediateWorkScheduler(),
  });
  const firstIdentity = { revision: 1, outputHash: first.value.hash };
  const nextIdentity = { revision: 2, outputHash: next.value.hash };
  const unsubscribe = documents.subscribe(() => {
    // Invalidate after the read resolves but before the preview adopts it.
    unsubscribe();
    documents.invalidate(file.path);
  }, file.path);

  try {
    await expect(documents.loadPreviewSource(file.path, firstIdentity)).rejects.toThrow(
      "changed while loading",
    );
    documents.deferRefresh(file.path);
    expect(documents.cached(file.path)).toBeUndefined();
    await expect(documents.loadPreviewSource(file.path, firstIdentity)).rejects.toThrow(
      "being refreshed",
    );
    expect(await documents.recognize(file.path)).toBe(false);
    expect(cachedRead).toHaveBeenCalledTimes(1);
    documents.invalidate(file.path);
    const current = await documents.loadPreviewSource(file.path, nextIdentity);
    const proof = documents.safeStaticProof(file.path);
    expect(proof).toBeDefined();
    await expect(documents.loadPreviewSource(file.path, firstIdentity)).rejects.toThrow(
      "changed while loading",
    );
    expect(current.safeSvg).toBe(next.value.svg);
    expect(documents.cached(file.path)).toBe(current);
    expect(documents.safeStaticProof(file.path)).toBe(proof);
    documents.deferRefresh(file.path);
    expect(documents.cached(file.path)).toBeUndefined();
    expect(await documents.recognize(file.path)).toBe(false);
    expect(documents.safeStaticProof(file.path)).toBeUndefined();
    expect(cachedRead).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
    documents.dispose();
  }
});
