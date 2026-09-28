import { describe, expect, it } from "vitest";
import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import { shouldHandleClipboardShortcut } from "../../../../src/persistence/clipboard/public";
import {
  encodeRuntimeSelection,
  resolveClipboardPayload,
} from "../../../../src/persistence/clipboard/codec";
import { planPaste, resolvePasteTarget } from "../../../../src/persistence/clipboard/operations";
import { DocumentModelRuntime } from "../../../../src/persistence/worker/runtime/document-model";
import type { ClipboardResult, PastePlan } from "../../../../src/persistence/clipboard/types";
import { createWorkerSnapshot } from "../../../fixtures/persistence/worker-snapshot";
import { ARROW_ID, page, RECTANGLE_ID, selectedElements, spatialRectangle } from "./fixtures";

const NEW_RECTANGLE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEW_ARROW_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const expectSpatialCapacityFailure = (result: ClipboardResult<PastePlan>): void => {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("limit-exceeded");
  expect(result.error.message).toMatch(/spatial-index capacity/);
};

const decodedFixture = () => {
  const encoded = encodeRuntimeSelection(selectedElements(), new Set([RECTANGLE_ID, ARROW_ID]));
  if (!encoded.ok) throw new Error(encoded.error.message);
  const decoded = resolveClipboardPayload({ customText: encoded.value.customText });
  if (!decoded.ok) throw new Error(decoded.error.message);
  return decoded.value;
};

const planCenteredPaste = () => {
  const ids = [NEW_RECTANGLE_ID, NEW_ARROW_ID];
  return planPaste({
    decoded: decodedFixture(),
    existingElements: [],
    page: page(),
    target: { x: 500, y: 500 },
    commandTimestamp: 9_000,
    createId: () => ids.shift()!,
  });
};

describe("paste planning", () => {
  it("resolves toolbar, context-menu, and shortcut placement points", () => {
    const center = { x: 400, y: 300 };
    const pointer = { x: 125, y: 225 };
    expect(resolvePasteTarget({ kind: "toolbar", visibleCanvasCenter: center })).toEqual(center);
    expect(resolvePasteTarget({ kind: "context-menu", invocationPoint: pointer })).toEqual(pointer);
    expect(
      resolvePasteTarget({
        kind: "shortcut",
        lastSessionPointer: pointer,
        visibleCanvasCenter: center,
      }),
    ).toEqual(pointer);
    expect(
      resolvePasteTarget({
        kind: "shortcut",
        lastSessionPointer: null,
        visibleCanvasCenter: center,
      }),
    ).toEqual(center);
  });

  it("preserves native shortcuts outside the active canvas or without applicable data", () => {
    const active = {
      pointerOverActiveEditor: true,
      textFieldFocused: false,
      hasSelection: true,
      hasValidInkPayload: true,
    };
    expect(shouldHandleClipboardShortcut("copy", active)).toBe(true);
    expect(shouldHandleClipboardShortcut("paste", active)).toBe(true);
    expect(shouldHandleClipboardShortcut("cut", { ...active, textFieldFocused: true })).toBe(false);
    expect(shouldHandleClipboardShortcut("copy", { ...active, hasSelection: false })).toBe(false);
    expect(shouldHandleClipboardShortcut("paste", { ...active, hasValidInkPayload: false })).toBe(
      false,
    );
  });
});

describe("paste record planning", () => {
  it("injects fresh IDs and one timestamp, remaps connections, and centers the group", () => {
    const plan = planCenteredPaste();

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.selectedIds).toEqual([NEW_RECTANGLE_ID, NEW_ARROW_ID]);
    expect(plan.value.highlightIds).toEqual([]);
    expect(plan.value.contentIds).toEqual([NEW_RECTANGLE_ID, NEW_ARROW_ID]);
    expect(plan.value.elements.every(({ createdAt }) => createdAt === 9_000)).toBe(true);
    expect(plan.value.activateTool).toBe("select");
    expect(plan.value.insertAtBandFront).toBe(true);
    expect(plan.value.translation).toEqual({ x: 380, y: 390 });
    const pastedArrow = plan.value.elements[1];
    expect(pastedArrow?.kind === "arrow" ? pastedArrow.startConnection?.targetId : undefined).toBe(
      NEW_RECTANGLE_ID,
    );
  });

  it("offsets each repeated paste of the canonical payload diagonally by 24 units", () => {
    const decoded = decodedFixture();
    const first = planCenteredPaste();
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const secondIds = [
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    ];
    const second = planPaste({
      decoded,
      existingElements: first.value.elements,
      page: page(),
      target: { x: 500, y: 500 },
      commandTimestamp: 9_001,
      createId: () => secondIds.shift()!,
      previousRepeat: first.value.repeatState,
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.translation.x - first.value.translation.x).toBe(24);
      expect(second.value.translation.y - first.value.translation.y).toBe(24);
      expect(second.value.repeatState.pasteCount).toBe(2);
    }
  });

  it("preserves negative placement and rejects invalid UUID injection atomically", () => {
    const normalizedIds = [NEW_RECTANGLE_ID, NEW_ARROW_ID];
    const normalized = planPaste({
      decoded: decodedFixture(),
      existingElements: [],
      page: page(),
      target: { x: -100, y: -100 },
      commandTimestamp: 9_000,
      createId: () => normalizedIds.shift()!,
    });
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(
        normalized.value.elements.some((element) => {
          const bounds = calculateElementBounds(element);
          return bounds.minX < 0 || bounds.minY < 0;
        }),
      ).toBe(true);
    }

    const invalid = planPaste({
      decoded: decodedFixture(),
      existingElements: [],
      page: page(),
      target: { x: 500, y: 500 },
      commandTimestamp: 9_000,
      createId: () => "not-a-uuid",
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid-schema" } });

    const invalidTarget = planPaste({
      decoded: decodedFixture(),
      existingElements: [],
      page: page(),
      target: { x: Number.NaN, y: 500 },
      commandTimestamp: 9_000,
      createId: () => NEW_RECTANGLE_ID,
    });
    expect(invalidTarget).toMatchObject({ ok: false, error: { code: "invalid-schema" } });
  });
});

describe("paste document limits", () => {
  it("rejects placement whose writing-row-aligned active height exceeds the document limit", () => {
    const ids = [NEW_RECTANGLE_ID, NEW_ARROW_ID];
    const result = planPaste({
      decoded: decodedFixture(),
      existingElements: [],
      page: page(),
      target: { x: 500, y: 999_800 },
      commandTimestamp: 9_000,
      createId: () => ids.shift()!,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "limit-exceeded" } });
  });

  it("rechecks aggregate spatial capacity during planning", () => {
    const currentElements = [
      ...Array.from({ length: 1_092 }, (_, index) => spatialRectangle(index)),
      spatialRectangle(1_092, 100),
    ];
    const ids = ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"];
    const rejectedPlan = planPaste({
      decoded: decodedFixture(),
      existingElements: currentElements,
      page: page(),
      target: { x: 500, y: 500 },
      commandTimestamp: 9_001,
      createId: () => ids.shift()!,
    });
    expect(rejectedPlan.ok).toBe(false);
    if (!rejectedPlan.ok) {
      expect(rejectedPlan.error).toMatchObject({ code: "limit-exceeded" });
      expect(rejectedPlan.error.message).toMatch(/spatial-index capacity/);
    }
  });
});

describe("validated worker paste limits", () => {
  it("enforces spatial capacity from the revision-matched worker aggregate", () => {
    const currentElements = [
      ...Array.from({ length: 1_092 }, (_, index) => spatialRectangle(index)),
      spatialRectangle(1_092, 100),
    ];
    const model = new DocumentModelRuntime();
    model.initialize(createWorkerSnapshot(currentElements));
    const ids = [NEW_RECTANGLE_ID, NEW_ARROW_ID];
    const result = model.planClipboardPaste(
      0,
      { customText: decodedFixture().customText },
      { kind: "toolbar", visibleCanvasCenter: { x: 500, y: 500 } },
      9_001,
      () => ids.shift()!,
    );
    expectSpatialCapacityFailure(result);
    model.synchronize({
      baseModelRevision: 0,
      identity: { operationId: 1, purpose: "clipboard", sessionId: "paste", workerEpoch: 1 },
      modelRevision: 1,
      removedIds: [currentElements[0]!.id],
      type: "model-sync-incremental",
    });
    expect(() =>
      model.planClipboardPaste(
        0,
        { customText: decodedFixture().customText },
        { kind: "toolbar", visibleCanvasCenter: { x: 500, y: 500 } },
        9_002,
        () => NEW_RECTANGLE_ID,
      ),
    ).toThrow("basis-revision-mismatch");
    const nextIds = [NEW_RECTANGLE_ID, NEW_ARROW_ID];
    const updated = model.planClipboardPaste(
      1,
      { customText: decodedFixture().customText },
      { kind: "toolbar", visibleCanvasCenter: { x: 500, y: 500 } },
      9_002,
      () => nextIds.shift()!,
    );
    expect(updated.ok).toBe(true);
    const collided = model.planClipboardPaste(
      1,
      { customText: decodedFixture().customText },
      { kind: "toolbar", visibleCanvasCenter: { x: 500, y: 500 } },
      9_002,
      () => currentElements[1]!.id,
    );
    expect(collided).toMatchObject({ ok: false, error: { code: "invalid-schema" } });
    expect(model.instrumentation).toMatchObject({
      fullValidationRuns: 1,
      incrementalValidationRuns: 1,
    });
  });

  it("rejects a paste that exceeds the worker's validated overflow count", () => {
    const existing = Array.from({ length: 512 }, (_, index) => spatialRectangle(index, 70_000));
    const model = new DocumentModelRuntime();
    model.initialize(createWorkerSnapshot(existing));
    const encoded = model.encodeClipboard(0, [existing[0]!.id]);
    if (!encoded.ok) throw new Error(encoded.error.message);
    const result = model.planClipboardPaste(
      0,
      { customText: encoded.value.customText },
      { kind: "toolbar", visibleCanvasCenter: { x: 500, y: 500 } },
      9_002,
      () => NEW_RECTANGLE_ID,
    );
    expectSpatialCapacityFailure(result);
  });
});
