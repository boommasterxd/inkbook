import { describe, expect, it } from "vitest";
import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import {
  classifyPasteResult,
  encodeSelection,
  isCurrentCut,
  isCurrentPasteResult,
  planPaste,
  resolvePasteTarget,
  resolveClipboardPayload,
  type ClipboardOperationIdentity,
  type CurrentClipboardState,
  type CutGuard,
  shouldHandleClipboardShortcut,
  validatePasteAdoption,
} from "../../../../src/persistence/clipboard/public";
import { ARROW_ID, page, RECTANGLE_ID, selectedElements, spatialRectangle } from "./fixtures";

const NEW_RECTANGLE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEW_ARROW_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const decodedFixture = () => {
  const encoded = encodeSelection(selectedElements(), new Set([RECTANGLE_ID, ARROW_ID]));
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

  it("rechecks aggregate spatial capacity during planning and adoption", () => {
    const currentElements = [
      ...Array.from({ length: 1_092 }, (_, index) => spatialRectangle(index)),
      spatialRectangle(1_092, 100),
    ];
    const plan = planCenteredPaste();
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

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

    const identity: ClipboardOperationIdentity = {
      sessionId: "session-a",
      workerEpoch: 2,
      clipboardOperationId: "clipboard-capacity",
      basisRevision: 12,
    };
    const rejectedAdoption = validatePasteAdoption({
      plan: plan.value,
      resultIdentity: identity,
      current: identity,
      currentElements,
      page: page(),
    });
    expect(rejectedAdoption.ok).toBe(false);
    if (!rejectedAdoption.ok) {
      expect(rejectedAdoption.error).toMatchObject({ code: "limit-exceeded" });
      expect(rejectedAdoption.error.message).toMatch(/spatial-index capacity/);
    }
  });
});

describe("stale clipboard guards", () => {
  const identity: ClipboardOperationIdentity = {
    sessionId: "session-a",
    workerEpoch: 2,
    clipboardOperationId: "clipboard-7",
    basisRevision: 12,
  };
  const records = [
    { id: RECTANGLE_ID, geometryVersion: 3, paintVersion: 4 },
    { id: ARROW_ID, geometryVersion: 5, paintVersion: 6 },
  ];

  it("accepts only matching Paste identity values", () => {
    expect(isCurrentPasteResult(identity, { ...identity })).toBe(true);
    expect(isCurrentPasteResult(identity, { ...identity, basisRevision: 13 })).toBe(false);
    expect(classifyPasteResult(identity, { ...identity, basisRevision: 13 }, true)).toBe(
      "recompute",
    );
    expect(classifyPasteResult(identity, { ...identity, basisRevision: 13 }, false)).toBe(
      "discard",
    );
  });

  it("rechecks Paste identity and current document IDs before adoption", () => {
    const plan = planCenteredPaste();
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(
      validatePasteAdoption({
        plan: plan.value,
        resultIdentity: identity,
        current: identity,
        currentElements: [],
        page: page(),
      }),
    ).toEqual({
      ok: true,
      value: undefined,
    });
    expect(
      validatePasteAdoption({
        plan: plan.value,
        resultIdentity: identity,
        current: identity,
        currentElements: [plan.value.elements[0]!],
        page: page(),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid-schema" },
    });
  });

  it("accepts Cut only while identity, exact selection versions, and attachment remain current", () => {
    const guard: CutGuard = { ...identity, selectedRecords: records };
    const current: CurrentClipboardState = {
      ...identity,
      presentationAttached: true,
      selectedRecords: [...records].reverse(),
    };
    expect(isCurrentCut(guard, current)).toBe(true);
    expect(
      isCurrentCut(guard, {
        ...current,
        selectedRecords: [{ ...records[0]!, geometryVersion: 99 }, records[1]!],
      }),
    ).toBe(false);
    expect(isCurrentCut(guard, { ...current, presentationAttached: false })).toBe(false);
  });
});
