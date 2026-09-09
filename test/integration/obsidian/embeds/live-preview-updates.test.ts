import { EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { createLivePreviewExtension } from "../../../../src/obsidian/embeds/live-preview";
import {
  documentRecognitionChanged,
  documentRecognitionUnavailable,
} from "../../../../src/obsidian/embeds/live-preview-recognition-effects";
import type { InkbookDocumentRecognition } from "../../../../src/obsidian/embeds/document-recognition";
import type { InkbookLoadingPreviewWidget } from "../../../../src/obsidian/embeds/live-preview-loading-widget";
import type { EmbedIntegrationPorts } from "../../../../src/obsidian/embeds/presentation-port";
import { configureTestEditorState } from "../../../adapters/obsidian/plugin";

function recognizedPreview(): InkbookDocumentRecognition {
  return {
    aspectRatio: 1,
    safeSvg: "<svg/>",
    contentIdentity: { revision: 1, outputHash: "a".repeat(64) },
  };
}

function harness(
  doc = "Ordinary prose\n\n!inkbook[[a.svg]]\n\n!inkbook[[b.svg]]\n\n!inkbook[[a.svg]]",
) {
  const cached = new Map<string, InkbookDocumentRecognition>();
  const resolveDocument = vi.fn((documentId: string) => ({
    documentId,
    resourceUrl: `app://${documentId}`,
  }));
  const ports = {
    documents: { cached: (id: string) => cached.get(id) },
    resolveDocument,
  } as unknown as EmbedIntegrationPorts;
  configureTestEditorState({ file: { path: "note.md" }, livePreview: true });
  const state = EditorState.create({
    doc,
    extensions: [editorInfoField, editorLivePreviewField, createLivePreviewExtension(ports)],
  });
  resolveDocument.mockClear();
  return { state, cached, resolveDocument };
}

function replacements(state: EditorState) {
  const entries: Array<{ from: number; to: number; widget: InkbookLoadingPreviewWidget }> = [];
  (state.facet(EditorView.decorations)[0] as DecorationSet).between(
    0,
    state.doc.length,
    (from, to, decoration) => {
      entries.push({
        from,
        to,
        widget: (decoration.spec as { widget: InkbookLoadingPreviewWidget }).widget,
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

  it("maps ordinary prose edits and retains entrance ownership without resolving links again", () => {
    const { state, resolveDocument } = harness();
    const original = replacements(state);
    const changed = state.update({ changes: { from: 2, to: 4, insert: "a longer edit" } }).state;
    const mapped = replacements(changed);
    expect(resolveDocument).not.toHaveBeenCalled();
    for (const [index, entry] of mapped.entries()) {
      expect(entry.from).toBe((original[index]?.from ?? 0) + 11);
      expect(entry.widget.entranceState).toBe(original[index]?.widget.entranceState);
      expect(changed.doc.sliceString(entry.from, entry.to)).toMatch(/^!inkbook/u);
    }
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
    const fenced = harness("```\n!inkbook[[a.svg]]\n```");
    expect(replacements(fenced.state.update({ changes: { from: 0, to: 3 } }).state)).toHaveLength(
      1,
    );
  });
});

describe("Live Preview fallback and mapping", () => {
  it.each(["---", "    code", "Title\n---"])(
    "reparses structural or indented lines %j",
    (prefix) => {
      const { state, resolveDocument } = harness(`${prefix}\n\n!inkbook[[a.svg]]`);
      const from = prefix.includes("\n") ? prefix.indexOf("\n") + 1 : 0;
      const changed = state.update({ changes: { from, to: from + 1 } }).state;
      expect(replacements(changed)).toHaveLength(1);
      expect(resolveDocument).toHaveBeenCalled();
    },
  );

  it("restores unavailable pending Markdown and retries after the next document edit", () => {
    const { state, resolveDocument } = harness();
    const failed = state.update({ effects: documentRecognitionUnavailable.of("a.svg") }).state;
    expect(replacements(failed)).toHaveLength(1);
    const retried = failed.update({ changes: { from: 2, insert: "x" } }).state;
    expect(replacements(retried)).toHaveLength(3);
    expect(resolveDocument).toHaveBeenCalledTimes(3);
  });

  it("keeps a safe preview after transient recognition rejection and refreshes on recovery", () => {
    const { state, cached } = harness();
    cached.set("a.svg", recognizedPreview());
    const ready = notify(state, "a.svg");
    cached.delete("a.svg");
    const failed = ready.update({ effects: documentRecognitionUnavailable.of("a.svg") }).state;
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
    expect(shifted[1]?.widget).toBe(before[1]?.widget);
    expect(shifted[0]?.from).toBe((before[0]?.from ?? 0) + 1);
    const unchanged = replacements(
      ready.update({ changes: { from: 2, to: 3, insert: "x" } }).state,
    );
    expect(unchanged[0]?.widget).toBe(before[0]?.widget);
  });
});
