// @vitest-environment happy-dom

import { expect, it, vi } from "vitest";
import type { TextElementV2 } from "../../../../../src/domain/schema/public";
import {
  navigateActiveTextHistory,
  useActiveTextSessions,
} from "../../../../fixtures/obsidian/active-text-session";
import { ActiveTextPreparation } from "../../../../../src/obsidian/embeds/active-editor/text-preparation";
import { singleLineTextElement, textElement } from "../../../../fixtures/rendering/text";
import { textPaddingForWidth } from "../../../../../src/domain/geometry/text-padding";

const mount = useActiveTextSessions();

it.each([
  { source: " Plain", old: [{ text: "Plain", start: 1, end: 6 }], width: 200, rows: [" Plain"] },
  {
    source: "a     b",
    old: [
      { text: "a", start: 0, end: 1 },
      { text: "b", start: 6, end: 7 },
    ],
    width: 28,
    rows: ["a  ", "   ", "b"],
  },
  { source: "Mid\tX", old: [{ text: "Mid    X", start: 0, end: 5 }], width: 200, rows: ["Mid X"] },
])(
  "repairs retained whitespace in $source through prepared history without an undo reentry loop",
  async ({ source, old, width, rows }) => {
    const original = textElement({
      source,
      width,
      pivot: { x: 10 + width / 2, y: 70 },
      layout: {
        version: 1,
        padding: 0,
        lines: old.map((run, index) => ({
          x: 0,
          y: index * 32,
          width: run.text.length * 8,
          height: 32,
          baseline: 24,
          runs: [{ ...run, x: 0, width: run.text.length * 8 }],
        })),
      },
    });
    const state = mount(original);
    vi.restoreAllMocks();
    const resource = {
      family: "inter",
      weight: 400,
      style: "normal",
      mimeType: "font/woff2",
      id: "a".repeat(64),
      data: "AA==",
    };
    Object.defineProperty(state.model, "fontResources", { value: [resource] });
    const descriptor = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load: async () => [] },
    });
    const prepare = vi.spyOn(ActiveTextPreparation.prototype, "prepare");
    const stored = () => state.model.store.get(original.id)!.element as TextElementV2;
    try {
      const opened = await state.session.edit(original.id, 3);
      expect(state.error.mock.calls).toEqual([]);
      expect(opened).toBe(true);
      const repaired = stored();
      const padding = textPaddingForWidth(original.style.fontSize, original.width * 2);
      expect(repaired).toMatchObject({
        source: original.source,
        width: original.width + padding * 2,
        layout: { padding },
      });
      expect(
        repaired.layout.lines.map((line) => line.runs.map((run) => run.text).join("")),
      ).toEqual(rows);
      expect(prepare).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.any(AbortSignal), {
        preservePadding: true,
      });
      expect(state.history.commandCount).toBe(1);
      expect(state.input().state.selection.main.head).toBe(3);
      await navigateActiveTextHistory(state);
      expect(stored()).toEqual(state.element);
      expect(state.history.canRedo).toBe(true);
      expect(prepare).toHaveBeenCalledOnce();
      await navigateActiveTextHistory(state, true);
      expect(stored()).toEqual(repaired);
      expect(state.history.commandCount).toBe(1);
      state.input().dispatch({ changes: { from: original.source.length, insert: " typed" } });
      await state.prepareExport();
      expect(state.session.active).toBe(false);
      expect(stored().source).toBe(source + " typed");
      expect(
        stored()
          .layout.lines.flatMap((line) => line.runs)
          .map((run) => run.text)
          .join(""),
      ).toBe(source.replace(/\t/gu, " ") + " typed");
      expect(state.history.commandCount).toBe(2);
      expect(state.operations()).toBe(0);
      expect(state.error).not.toHaveBeenCalled();
      const preparations = prepare.mock.calls.length;
      await expect(state.session.edit(original.id)).resolves.toBe(true);
      await expect(state.session.finish()).resolves.toBe(true);
      expect(prepare).toHaveBeenCalledTimes(preparations);
      expect(state.history.commandCount).toBe(2);
    } finally {
      state.session.dispose();
      if (descriptor) Object.defineProperty(document, "fonts", descriptor);
      else Reflect.deleteProperty(document, "fonts");
    }
  },
);

it("does not repair an already faithful layout on ordinary edit reentry", async () => {
  const element = singleLineTextElement(" Plain");
  const state = mount(element);
  const opened = await state.session.edit(element.id);
  expect(state.error.mock.calls).toEqual([]);
  expect(opened).toBe(true);
  await expect(state.session.finish()).resolves.toBe(true);
  expect(state.prepare).not.toHaveBeenCalled();
  expect(state.history.commandCount).toBe(0);
  expect(state.error).not.toHaveBeenCalled();
});
