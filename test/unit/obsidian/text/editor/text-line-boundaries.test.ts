import { EditorState, Text } from "@codemirror/state";
import type { WidgetType } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  setTextLineBoundaries,
  textLineBoundaries,
  textLineBoundariesSteps,
} from "../../../../../src/obsidian/text/editor/text-line-boundaries";
import { finishGeometrySteps } from "../../../../fixtures/domain/geometry-steps";

function prepared(source: string): EditorState {
  const state = EditorState.create({ doc: source, extensions: [textLineBoundaries] });
  return state.update({
    effects: setTextLineBoundaries.of(finishGeometrySteps(textLineBoundariesSteps(state.doc))),
  }).state;
}

function positions(state: EditorState): number[] {
  const result: number[] = [];
  state.field(textLineBoundaries).between(0, state.doc.length, (from, to, decoration) => {
    const spec = decoration.spec as { widget: WidgetType; block: boolean; side: number };
    expect(to).toBe(from);
    expect(spec.block).toBe(true);
    expect(spec.side).toBe(-1);
    expect(spec.widget.estimatedHeight).toBe(0);
    result.push(from);
  });
  return result;
}

describe("native structural hardline boundaries", () => {
  it("adds honest zero-height point blocks without replacing text and reuses them for caret changes", () => {
    const source = "One\nTwo\nThree";
    const state = prepared(source);
    expect(positions(state)).toEqual([0, 4, 8]);
    const moved = state.update({ selection: { anchor: source.length } }).state;
    expect(moved.field(textLineBoundaries)).toBe(state.field(textLineBoundaries));
    expect(moved.doc.toString()).toBe(source);
  });

  it("removes a mapped boundary that would otherwise split a merged hardline after Backspace", () => {
    const state = prepared("One\nTwo");
    const joined = state.update({ changes: { from: 3, to: 4 } }).state;
    expect(joined.doc.toString()).toBe("OneTwo");
    expect(positions(joined)).toEqual([0]);
  });

  it("checks only locally affected boundaries during native edits at supported source capacity", () => {
    const state = prepared("word\n".repeat(3_000));
    const lines = vi.spyOn(Text.prototype, "lineAt");
    try {
      const changed = state.update({ changes: { from: 1, insert: "x" } }).state;
      expect(changed.field(textLineBoundaries).size).toBe(3_001);
      expect(lines.mock.calls.length).toBeLessThan(10);
    } finally {
      lines.mockRestore();
    }
  });
});
