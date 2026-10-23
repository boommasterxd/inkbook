import { expect, it, vi } from "vitest";
import { capturePastePlan } from "../../../../src/persistence/clipboard/paste-plan-snapshot";
import { createPastePlan } from "../../../integration/obsidian/embeds/active-editor/active-editor-clipboard-fixtures";
import { rectangle } from "../../domain/store/fixtures";

it("owns plan metadata and reuses only the privately captured immutable wrapper", () => {
  const source = createPastePlan(rectangle());
  const captured = capturePastePlan(source)!;
  source.selectedIds = [];
  source.repeatState.pasteCount = 99;
  source.translation.x = 99;
  expect(captured.selectedIds).toHaveLength(1);
  expect(captured.repeatState.pasteCount).toBe(1);
  expect(captured.translation.x).not.toBe(99);
  expect(Object.isFrozen(captured)).toBe(true);
  expect(Object.isFrozen(captured.selectedIds)).toBe(true);
  expect(capturePastePlan(captured)).toBe(captured);
});

it.each([
  { elements: null },
  { elements: [null] },
  { elements: [42] },
  { selectedIds: [42] },
  { selectedIds: new Array(1) },
  { translation: null },
  { translation: { x: Infinity, y: 0 } },
  { repeatState: null },
  { repeatState: { fingerprint: 42, pasteCount: 1 } },
  { repeatState: { fingerprint: "test", pasteCount: 0 } },
  { commandTimestamp: -1 },
  { activateTool: "pen" },
  { insertAtBandFront: false },
])("rejects malformed plan metadata %j", (changes) => {
  const source = Object.assign(createPastePlan(rectangle()), changes);
  expect(capturePastePlan(source)).toBeNull();
});

it("rejects accessor plan metadata without invoking it", () => {
  const source = createPastePlan(rectangle());
  const getter = vi.fn(() => []);
  Object.defineProperty(source, "selectedIds", { get: getter });
  expect(capturePastePlan(source)).toBeNull();
  expect(getter).not.toHaveBeenCalled();
});
