import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LivePreviewBlocks } from "../../../../../src/obsidian/embeds/live-preview/live-preview-blocks";
import { createLivePreviewExtension } from "../../../../../src/obsidian/embeds/live-preview/live-preview";
import { documentRecognitionChanged } from "../../../../../src/obsidian/embeds/live-preview/live-preview-recognition-effects";
import type { InkbookDocumentRecognition } from "../../../../../src/obsidian/embeds/preview/document-recognition";
import type { InkbookLivePreviewWidget } from "../../../../../src/obsidian/embeds/live-preview/live-preview-widget";
import type { EmbedIntegrationPorts } from "../../../../../src/obsidian/embeds/presentation/presentation-port";
import { configureTestEditorState } from "../../../../adapters/obsidian/plugin";

function recognizedPreview(): InkbookDocumentRecognition {
  return {
    aspectRatio: 1,
    safeSvg: "<svg/>",
    contentIdentity: { revision: 1, outputHash: "a".repeat(64) },
  };
}

function harness(doc = "Ordinary prose\n\n![[a.svg]]\n\n![[b.svg]]\n\n![[a.svg]]") {
  const cached = new Map<string, InkbookDocumentRecognition>([
    ["a.svg", recognizedPreview()],
    ["b.svg", recognizedPreview()],
  ]);
  const resolveDocument = vi.fn((documentId: string) => ({
    documentId,
    resourceUrl: `app://${documentId}`,
  }));
  const cachedRead = vi.fn((id: string) => cached.get(id));
  const ports = {
    documents: { cached: cachedRead },
    resolveDocument,
  } as unknown as EmbedIntegrationPorts;
  configureTestEditorState({ file: { path: "note.md" }, livePreview: true });
  const state = EditorState.create({
    doc,
    extensions: [editorInfoField, editorLivePreviewField, createLivePreviewExtension(ports)],
  });
  resolveDocument.mockClear();
  cachedRead.mockClear();
  return { state, cached, cachedRead, resolveDocument };
}

function replacements(state: EditorState) {
  const entries: Array<{ from: number; to: number; widget: InkbookLivePreviewWidget }> = [];
  (state.facet(EditorView.decorations)[0] as DecorationSet).between(
    0,
    state.doc.length,
    (from, to, decoration) => {
      entries.push({
        from,
        to,
        widget: (decoration.spec as { widget: InkbookLivePreviewWidget }).widget,
      });
    },
  );
  return entries;
}

function notify(state: EditorState, ...ids: string[]) {
  return state.update({ effects: documentRecognitionChanged.of(ids) }).state;
}

describe("Live Preview targeted state updates", () => {
  it("refreshes every affected occurrence while preserving unrelated widgets without link resolution", () => {
    const { state, cached, resolveDocument } = harness();
    const original = replacements(state);
    cached.set("a.svg", false);
    const changed = notify(state, "a.svg", "missing.svg");
    expect(replacements(changed)).toEqual([original[1]]);
    expect(resolveDocument).not.toHaveBeenCalled();
  });

  it("retains pending documents in a mixed recognition batch and accepts later recovery", () => {
    const { state, cached, resolveDocument } = harness();
    cached.set("a.svg", false);
    const failed = notify(state, "a.svg", "b.svg");
    expect(replacements(failed)).toHaveLength(1);
    cached.delete("a.svg");
    expect(notify(failed, "a.svg").facet(EditorView.decorations)[0]).toBe(
      failed.facet(EditorView.decorations)[0],
    );
    cached.set("a.svg", recognizedPreview());
    expect(replacements(notify(failed, "a.svg"))).toHaveLength(3);
    expect(resolveDocument).not.toHaveBeenCalled();
  });

  it("maps ordinary prose edits and retains widget identity contracts without resolving links again", () => {
    const { state, resolveDocument } = harness();
    const original = replacements(state);
    const changed = state.update({ changes: { from: 2, to: 4, insert: "a longer edit" } }).state;
    const mapped = replacements(changed);
    expect(resolveDocument).not.toHaveBeenCalled();
    for (const [index, entry] of mapped.entries()) {
      expect(entry.from).toBe((original[index]?.from ?? 0) + 11);
      expect(entry.widget.eq(original[index]!.widget.withRange(entry.from, entry.to))).toBe(true);
      expect(changed.doc.sliceString(entry.from, entry.to)).toMatch(/^!/u);
    }
  });

  it("refreshes pending and rejected candidates at their current positions after successive prose edits", () => {
    const { state, cached, cachedRead, resolveDocument } = harness();
    cached.set("a.svg", false);
    let current = notify(state, "a.svg");
    cached.delete("a.svg");
    current = current.update({ changes: { from: 2, insert: "longer" } }).state;
    current = current.update({ changes: { from: 1, to: 3, insert: "x" } }).state;
    const unrelated = replacements(current)[0]!;
    cached.set("a.svg", recognizedPreview());
    cachedRead.mockClear();
    const recovered = replacements(notify(current, "a.svg"));
    expect(recovered).toHaveLength(3);
    expect(recovered[1]?.widget).toBe(unrelated.widget);
    expect(recovered.map(({ from, to }) => current.doc.sliceString(from, to))).toEqual([
      "![[a.svg]]",
      "![[b.svg]]",
      "![[a.svg]]",
    ]);
    expect(cachedRead).toHaveBeenCalledExactlyOnceWith("a.svg");
    expect(resolveDocument).not.toHaveBeenCalled();
  });

  it.each(["<!--", "```\n", "\n", "!"])("reparses a structural insertion %j", (insert) => {
    const { state, resolveDocument } = harness();
    const changed = state.update({ changes: { from: 0, insert } }).state;
    if (insert === "<!--" || insert === "```\n") expect(replacements(changed)).toHaveLength(0);
    else expect(resolveDocument).toHaveBeenCalledTimes(3);
  });

  it("reparses deletion across lines and changes inside embed or fence lines", () => {
    const { state } = harness();
    const first = replacements(state)[0];
    expect(first).toBeDefined();
    const changed = state.update({ changes: { from: 0, to: (first?.from ?? 0) + 1 } }).state;
    expect(replacements(changed)).toHaveLength(2);
    const fenced = harness("```\n![[a.svg]]\n```");
    expect(replacements(fenced.state.update({ changes: { from: 0, to: 3 } }).state)).toHaveLength(
      1,
    );
  });
});

describe("Live Preview fallback and mapping", () => {
  it.each(["---", "    code", "Title\n---"])(
    "reparses structural or indented lines %j",
    (prefix) => {
      const { state, resolveDocument } = harness(`${prefix}\n\n![[a.svg]]`);
      const from = prefix.includes("\n") ? prefix.indexOf("\n") + 1 : 0;
      const changed = state.update({ changes: { from, to: from + 1 } }).state;
      expect(replacements(changed)).toHaveLength(1);
      expect(resolveDocument).toHaveBeenCalled();
    },
  );

  it("keeps a safe preview after transient recognition rejection and refreshes on recovery", () => {
    const { state, cached } = harness();
    cached.set("a.svg", recognizedPreview());
    const ready = notify(state, "a.svg");
    cached.delete("a.svg");
    const failed = notify(ready, "a.svg");
    expect(replacements(failed)).toEqual(replacements(ready));
    cached.set("a.svg", false);
    expect(replacements(notify(failed, "a.svg"))).toHaveLength(1);
  });

  it("maps ready widget references to edited source positions while retaining unchanged widgets", () => {
    const { state, cached } = harness();
    cached.set("a.svg", recognizedPreview());
    const ready = notify(state, "a.svg");
    const before = replacements(ready);
    const shifted = replacements(ready.update({ changes: { from: 2, insert: "x" } }).state);
    expect(shifted[0]?.widget).not.toBe(before[0]?.widget);
    expect(shifted[1]?.widget).not.toBe(before[1]?.widget);
    expect(shifted[0]?.from).toBe((before[0]?.from ?? 0) + 1);
    const unchanged = replacements(
      ready.update({ changes: { from: 2, to: 3, insert: "x" } }).state,
    );
    expect(unchanged[0]?.widget).toBe(before[0]?.widget);
  });
});

describe("Live Preview recognition effect work", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["none", "foreign", "empty"])("skips block refresh for %s recognition work", (kind) => {
    const { state, cachedRead, resolveDocument } = harness();
    const refresh = vi.spyOn(LivePreviewBlocks.prototype, "refresh");
    const effects =
      kind === "none"
        ? []
        : kind === "foreign"
          ? [StateEffect.define<number>().of(1)]
          : [documentRecognitionChanged.of([])];
    const updated = state.update({ effects }).state;
    expect(updated.facet(EditorView.decorations)[0]).toBe(state.facet(EditorView.decorations)[0]);
    expect(refresh).not.toHaveBeenCalled();
    expect(cachedRead).not.toHaveBeenCalled();
    expect(resolveDocument).not.toHaveBeenCalled();
  });

  it("deduplicates recognition changes and refreshes affected occurrences", () => {
    const { state, cached, cachedRead, resolveDocument } = harness();
    cached.set("a.svg", recognizedPreview());
    cached.set("b.svg", false);
    const effects = [
      documentRecognitionChanged.of(["a.svg", "a.svg"]),
      StateEffect.define<number>().of(1),
      documentRecognitionChanged.of(["a.svg", "b.svg"]),
    ];
    const updated = state.update({ effects }).state;
    const entries = replacements(updated);
    expect(entries.map((entry) => entry.from)).toEqual([
      replacements(state)[0]?.from,
      replacements(state)[2]?.from,
    ]);
    expect(cachedRead.mock.calls).toEqual([["a.svg"], ["b.svg"]]);
    expect(resolveDocument).not.toHaveBeenCalled();
    expect(entries.every((entry) => entry.widget !== replacements(state)[0]?.widget)).toBe(true);
  });
});
