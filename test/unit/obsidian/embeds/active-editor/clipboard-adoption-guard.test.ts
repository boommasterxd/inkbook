import { expect, it, vi } from "vitest";
import { ClipboardAdoptionGuard } from "../../../../../src/obsidian/embeds/active-editor/clipboard-adoption-guard";
import { ElementStore } from "../../../../../src/domain/store/public";
import type { PastePlan } from "../../../../../src/persistence/clipboard/types";
import { highlighter, PAGE } from "../../../domain/store/fixtures";
import { rectangle } from "../../../domain/geometry/fixtures";
import { createDecodedClipboardFixture } from "../../../persistence/clipboard/fixtures";
import { planPaste } from "../../../../../src/persistence/clipboard/operations";
import { calculateElementBounds } from "../../../../../src/domain/geometry/public";

function plan(): PastePlan {
  const element = highlighter();
  return {
    elements: [element],
    selectedIds: [element.id],
    highlightIds: [element.id],
    contentIds: [],
    activateTool: "select",
    insertAtBandFront: true,
    commandTimestamp: 1,
    translation: { x: 0, y: 0 },
    repeatState: { fingerprint: "test", pasteCount: 1 },
  };
}

it("admits a copied rotated shape after translation across a canonical rounding boundary", async () => {
  const source = rectangle({
    x: 921.576,
    y: 171.422,
    width: 220.122,
    height: 122.073,
    pivot: { x: 1031.637, y: 232.458 },
    rotation: 10,
  });
  const bounds = calculateElementBounds(source);
  const result = planPaste({
    decoded: createDecodedClipboardFixture([source]),
    existingElements: [],
    page: PAGE,
    target: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 + 100 },
    commandTimestamp: 1,
    createId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value.translation).toEqual({ x: 0, y: 100 });
  const guard = new ClipboardAdoptionGuard(new ElementStore());
  try {
    const prepared = await guard.prepare(result.value, {
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });
    expect(prepared).not.toBeNull();
    expect(guard.accepts(prepared!, PAGE)).toBe(true);
    expect(prepared?.elements[0]?.pivot).toEqual({ x: 1031.637, y: 332.459 });
  } finally {
    guard.dispose();
  }
});

it("captures plan membership before the first yield and rejects changed element IDs", async () => {
  const guard = new ClipboardAdoptionGuard(new ElementStore());
  const original = plan();
  let yields = 0;
  const prepared = await guard.prepare(original, {
    shouldYield: () => yields === 0,
    yieldControl: async () => {
      yields += 1;
      original.elements[0]!.id = "00000000-0000-4000-8000-000000000099";
      original.selectedIds = [original.elements[0]!.id];
      original.highlightIds = [...original.selectedIds];
    },
  });
  expect(yields).toBe(1);
  expect(prepared).toBeNull();
  guard.dispose();
});

it("preserves captured metadata when the original plan changes during admission", async () => {
  const guard = new ClipboardAdoptionGuard(new ElementStore());
  const original = plan();
  const id = original.elements[0]!.id;
  let yielded = false;
  const prepared = await guard.prepare(original, {
    shouldYield: () => !yielded,
    yieldControl: async () => {
      yielded = true;
      original.elements = [];
      original.selectedIds = [];
      original.highlightIds = [];
      original.commandTimestamp = -1;
    },
  });
  expect(prepared?.elements.map((element) => element.id)).toEqual([id]);
  expect([...prepared!.ids]).toEqual([id]);
  expect(guard.accepts(prepared!, PAGE)).toBe(true);
  guard.dispose();
});

it("rejects metadata and element accessors without executing getters", async () => {
  const guard = new ClipboardAdoptionGuard(new ElementStore());
  for (const target of ["wrapper", "element"] as const) {
    const original = plan();
    const getter = vi.fn(() => "unsafe");
    Object.defineProperty(
      target === "wrapper" ? original : original.elements[0]!,
      target === "wrapper" ? "selectedIds" : "id",
      { enumerable: true, get: getter },
    );
    expect(
      await guard.prepare(original, {
        shouldYield: () => false,
        yieldControl: async () => undefined,
      }),
    ).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  }
  guard.dispose();
});
