// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { mountActiveTextSession } from "../../../../fixtures/obsidian/active-text-session";
import { textElement } from "../../../../unit/domain/schema/fixtures";
import type { ActiveTextSession } from "../../../../../src/obsidian/embeds/active-editor/text-session";
import type { TextElementV2 } from "../../../../../src/domain/schema/public";

let session: ActiveTextSession | undefined;
afterEach(() => {
  session?.dispose();
  session = undefined;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("applies selected and pending backgrounds to source ranges while preserving the element box", async () => {
  const element = {
    ...textElement(),
    source: "One Two",
    backgroundColor: { type: "rgba" as const, value: "#3B82F6FF" as const },
    backgroundOpacity: 0.25,
  };
  const state = mountActiveTextSession({ element });
  session = state.session;
  await session.edit(element.id);
  const input = state.input();
  input.contentDOM.blur();
  input.dispatch({ selection: { anchor: 4, head: 7 } });
  expect(session.applyStyle("text-background-color", "#EF4444FF")).toBe(true);
  expect(session.applyStyle("text-background-opacity", 0.5)).toBe(true);
  await expect(session.flush()).resolves.toBe(true);
  const saved = () => state.model.store.get(element.id)!.element as TextElementV2;
  expect(saved().backgroundColor).toEqual(element.backgroundColor);
  expect(saved().backgroundOpacity).toBe(0.25);
  expect(saved().ranges).toEqual([
    {
      start: 4,
      end: 7,
      style: { backgroundColor: { type: "rgba", value: "#EF4444FF" }, backgroundOpacity: 0.5 },
    },
  ]);
  input.dispatch({ selection: { anchor: 5 } });
  expect(session.styleSummary()).toMatchObject({
    backgroundColor: { type: "rgba", value: "#EF4444FF" },
    backgroundOpacity: 0.5,
  });
  input.dispatch({ selection: { anchor: 1 } });
  expect(session.styleSummary()).toMatchObject({
    backgroundColor: element.backgroundColor,
    backgroundOpacity: 0.25,
  });
  input.dispatch({ selection: { anchor: 0, head: 7 } });
  expect(session.styleSummary()).toMatchObject({
    backgroundColor: "mixed",
    backgroundOpacity: "mixed",
  });
  input.dispatch({ selection: { anchor: 1 } });
  const commands = state.history.commandCount;
  expect(session.applyStyle("text-background-color", "none")).toBe(true);
  expect(session.styleSummary()?.backgroundColor).toBeNull();
  expect(state.history.commandCount).toBe(commands);
  input.dispatch({ changes: { from: 1, insert: "!" }, selection: { anchor: 2 } });
  await session.flush();
  expect(saved().ranges).toContainEqual({ start: 1, end: 2, style: { backgroundColor: null } });
  input.dispatch({ selection: { anchor: 0, head: input.state.doc.length } });
  expect(session.applyStyle("text-background-opacity", 0.75)).toBe(true);
  await session.flush();
  expect(session.styleSummary()?.backgroundOpacity).toBe(0.75);
  expect(saved().backgroundColor).toEqual(element.backgroundColor);
  expect(saved().backgroundOpacity).toBe(0.25);
  expect(saved().ranges.every((range) => range.style.backgroundOpacity === 0.75)).toBe(true);
  expect(state.error).not.toHaveBeenCalled();
});
