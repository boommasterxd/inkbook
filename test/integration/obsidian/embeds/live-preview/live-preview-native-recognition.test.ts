// @vitest-environment happy-dom

import { EditorState, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { expect, it, vi } from "vitest";

import { createLivePreviewExtension } from "../../../../../src/obsidian/embeds/live-preview/live-preview";
import type { EmbedIntegrationPorts } from "../../../../../src/obsidian/embeds/presentation/presentation-port";
import { configureTestEditorState } from "../../../../adapters/obsidian/plugin";

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

it("does not recognize maximum-capacity candidates hidden by one folded multiline block", () => {
  const source = Array.from({ length: 4096 }, (_, index) => `![[drawing-${index}.svg]]`).join("\n");
  const blockReads = vi.spyOn(EditorView.prototype, "lineBlockAt");
  const viewportReads = vi.spyOn(EditorView.prototype, "viewportLineBlocks", "get");
  const h = fixture(source, { from: 0, to: source.length });
  try {
    expect(h.recognize).not.toHaveBeenCalled();
    expect(blockReads).not.toHaveBeenCalled();
    expect(viewportReads).toHaveBeenCalledOnce();
  } finally {
    h.dispose();
    blockReads.mockRestore();
    viewportReads.mockRestore();
  }
});

it("does not start reads for maximum-capacity native candidates outside the editor viewport", () => {
  const visible = "![[visible-handwriting-document.svg]]";
  const offscreen = Array.from(
    { length: 4095 },
    (_, index) => `![[offscreen-document-${index}.svg]]`,
  ).join("\n");
  const source = `${visible}\n${"Ordinary prose\n".repeat(3000)}${offscreen}`;
  const h = fixture(source, { from: 0, to: visible.length });
  try {
    expect(h.view.viewport.to).toBeLessThan(source.indexOf(offscreen));
    expect(h.recognize).toHaveBeenCalledExactlyOnceWith(
      "visible-handwriting-document.svg",
      h.view.dom.ownerDocument.defaultView,
    );
    expect(h.cached).toHaveBeenCalledTimes(4097);
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
