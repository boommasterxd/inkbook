import { EditorSelection, EditorState, StateEffect, type TransactionSpec } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { removeLivePreviewMarkdown } from "../../../../src/obsidian/embeds/live-preview-removal";

const snapshotEffect = StateEffect.define<{ anchor: number; offset: number }>({
  map: (value, changes) => ({ ...value, anchor: changes.mapPos(value.anchor) }),
});
const source = "Before\n\n!inkbook[[page.svg]]\n\nAfter\nLast";
const range = { from: source.indexOf("\n\n") + 1, to: source.indexOf("After") };

function harness(anchor: number, offset: number) {
  let state = EditorState.create({ doc: source, selection: EditorSelection.cursor(source.length) });
  const snapshot = snapshotEffect.of({ anchor, offset });
  const dispatch = vi.fn((spec: TransactionSpec) => {
    state = state.update(spec).state;
  });
  return {
    get state() {
      return state;
    },
    dispatch,
    mutate: vi.fn(() => {
      state = state.update({ changes: { from: range.from, to: range.to } }).state;
    }),
    scrollSnapshot: vi.fn(() => snapshot),
  };
}

describe("Live Preview deletion scroll transaction", () => {
  it.each([0, source.indexOf("After")])(
    "maps the visible anchor %s instead of revealing the distant cursor",
    (anchor) => {
      const h = harness(anchor, 13);
      expect(removeLivePreviewMarkdown(h, range, source, h.mutate)).toBe(true);
      expect(h.state.doc.toString()).toBe("Before\nAfter\nLast");
      expect(h.state.selection.main.head).toBe(h.state.doc.length);
      const spec = h.dispatch.mock.calls[0]![0];
      expect(h.mutate).toHaveBeenCalledOnce();
      expect(spec.changes).toBeUndefined();
      expect(spec.scrollIntoView).toBe(false);
      const effect = spec.effects as StateEffect<{ anchor: number; offset: number }>;
      expect(effect.is(snapshotEffect)).toBe(true);
      expect(effect.value).toEqual({ anchor: anchor === 0 ? 0 : "Before\n".length, offset: 13 });
    },
  );

  it("rejects a stale note without capturing or changing scroll", () => {
    const h = harness(0, 0);
    expect(removeLivePreviewMarkdown(h, range, "stale", h.mutate)).toBe(false);
    expect(h.scrollSnapshot).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});

it("does not change text when the captured scroll position cannot be mapped", () => {
  const h = harness(0, 0);
  const dropped = StateEffect.define<{ anchor: number; offset: number }>({ map: () => undefined });
  h.scrollSnapshot.mockReturnValue(dropped.of({ anchor: 0, offset: 0 }));
  expect(removeLivePreviewMarkdown(h, range, source, h.mutate)).toBe(false);
  expect(h.mutate).not.toHaveBeenCalled();
  expect(h.dispatch).not.toHaveBeenCalled();
});

it("does not apply a scroll effect if the host refused its text mutation", () => {
  const h = harness(0, 0);
  const refused = vi.fn();
  expect(removeLivePreviewMarkdown(h, range, source, refused)).toBe(false);
  expect(refused).toHaveBeenCalledOnce();
  expect(h.dispatch).not.toHaveBeenCalled();
});

it("reports verified deletion even when the host rejects the later scroll effect", () => {
  const h = harness(0, 0);
  h.dispatch.mockImplementation(() => {
    throw new Error("View was disposed");
  });
  expect(removeLivePreviewMarkdown(h, range, source, h.mutate)).toBe(true);
  expect(h.state.doc.toString()).toBe("Before\nAfter\nLast");
  expect(h.mutate).toHaveBeenCalledOnce();
  expect(h.dispatch).toHaveBeenCalledOnce();
});
