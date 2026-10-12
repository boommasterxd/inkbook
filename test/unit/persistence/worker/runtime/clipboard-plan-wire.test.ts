import { describe, expect, it, vi } from "vitest";

import {
  decodeRuntimeResult,
  decodeRuntimeResultChunked,
  encodeRuntimeResult,
  encodeRuntimeResultChunked,
} from "../../../../../src/persistence/worker/runtime/wire-codec";
import { STROKE } from "./fixtures";
import { maximumLengthHighlighter } from "../../../domain/store/fixtures";
import type { PlanClipboardPasteRuntimeSuccess } from "../../../../../src/persistence/worker/runtime/types";
import type { StrokeElementV1 } from "../../../../../src/domain/schema/public";

function pasteResult(element: StrokeElementV1 = STROKE): PlanClipboardPasteRuntimeSuccess {
  const ids = [element.id];
  return {
    identity: { operationId: 1, purpose: "clipboard", sessionId: "session-a", workerEpoch: 1 },
    type: "clipboard-plan-paste-success",
    result: {
      ok: true,
      value: {
        activateTool: "select",
        commandTimestamp: 1,
        contentIds: element.tool === "highlighter" ? [] : ids,
        elements: [element],
        highlightIds: element.tool === "highlighter" ? ids : [],
        insertAtBandFront: true,
        repeatState: { fingerprint: "stroke", pasteCount: 1 },
        selectedIds: ids,
        translation: { x: 0, y: 0 },
      },
    },
  };
}

it.each([Number.NaN, -0, 1_000_001, 0.0001])(
  "completely validates untrusted wire samples despite caller flags (%s)",
  async (value) => {
    const encoded = encodeRuntimeResult(pasteResult());
    if (encoded.value.type !== "clipboard-plan-paste-success-wire" || !encoded.value.result.ok)
      throw new Error("Expected a packed plan.");
    const wire = encoded.value;
    const plan = encoded.value.result.value;
    plan.elements.pointBuffers[0]![0] = value;
    Object.assign(wire, { validated: true, fromClipboard: true });
    expect(() => decodeRuntimeResult(wire)).toThrow();
    await expect(
      decodeRuntimeResultChunked(wire, {
        checkpoint: () => undefined,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  },
);

it("rejects wire-header accessors without executing them", () => {
  const encoded = encodeRuntimeResult(pasteResult());
  if (encoded.value.type !== "clipboard-plan-paste-success-wire" || !encoded.value.result.ok)
    throw new Error("Expected a packed plan.");
  const getter = vi.fn(() => STROKE.id);
  Object.defineProperty(encoded.value.result.value.elements.records[0]!, "id", {
    get: getter,
    enumerable: true,
  });
  expect(() => decodeRuntimeResult(encoded.value)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

it("captures wire headers and copied samples before asynchronous callers can mutate them", async () => {
  const encoded = encodeRuntimeResult(pasteResult(maximumLengthHighlighter()));
  if (encoded.value.type !== "clipboard-plan-paste-success-wire" || !encoded.value.result.ok)
    throw new Error("Expected a packed plan.");
  const wire = encoded.value;
  const plan = encoded.value.result.value;
  const points = plan.elements.pointBuffers[0]!;
  const before = points[0];
  let mutated = false;
  const decoded = await decodeRuntimeResultChunked(wire, {
    signal: new AbortController().signal,
    checkpoint: async () => {
      if (mutated) return;
      mutated = true;
      points[0] = Number.NaN;
      plan.elements.records[0]!.id = "changed";
    },
  });
  if (decoded.type !== "clipboard-plan-paste-success" || !decoded.result.ok)
    throw new Error("Expected an independently captured plan.");
  const element = decoded.result.value.elements[0]!;
  expect(element.id).not.toBe("changed");
  expect(element.kind === "stroke" && element.points[0]).toBe(before);
  expect(element.kind === "stroke" && Object.isFrozen(element.points)).toBe(true);
});

describe("clipboard paste-plan wire codec", () => {
  it("slices wire sample packing and adoption and cancels both before publication", async () => {
    const element = maximumLengthHighlighter();
    const result = pasteResult(element);
    let packing = 0;
    const encoded = await encodeRuntimeResultChunked(result, {
      signal: new AbortController().signal,
      checkpoint: () => {
        packing += 1;
        return undefined;
      },
    });
    expect(packing).toBeGreaterThan(1);
    let adoption = 0;
    const decoded = await decodeRuntimeResultChunked(encoded.value, {
      signal: new AbortController().signal,
      checkpoint: () => {
        adoption += 1;
        return undefined;
      },
    });
    expect(adoption).toBeGreaterThan(1);
    if (decoded.type !== "clipboard-plan-paste-success" || !decoded.result.ok)
      throw new Error("Expected decoded plan.");
    expect(Object.isFrozen(decoded.result.value.elements[0])).toBe(true);
    for (const action of [
      (options: { signal: AbortSignal; checkpoint: () => undefined }) =>
        encodeRuntimeResultChunked(result, options),
      (options: { signal: AbortSignal; checkpoint: () => undefined }) =>
        decodeRuntimeResultChunked(encoded.value, options),
    ]) {
      const abort = new AbortController();
      await expect(
        action({
          signal: abort.signal,
          checkpoint: () => {
            abort.abort();
            return undefined;
          },
        }),
      ).rejects.toThrow();
    }
  });
  it("returns JSON-compatible stroke samples for insertion into the element store", () => {
    const encoded = encodeRuntimeResult({
      identity: {
        operationId: 1,
        purpose: "clipboard",
        sessionId: "session-a",
        workerEpoch: 1,
      },
      result: {
        ok: true,
        value: {
          activateTool: "select",
          commandTimestamp: 1,
          contentIds: [STROKE.id],
          elements: [STROKE],
          highlightIds: [],
          insertAtBandFront: true,
          repeatState: { fingerprint: "stroke", pasteCount: 1 },
          selectedIds: [STROKE.id],
          translation: { x: 0, y: 0 },
        },
      },
      type: "clipboard-plan-paste-success",
    });
    const transferred = structuredClone(encoded.value, { transfer: [...encoded.transfer] });
    const decoded = decodeRuntimeResult(transferred);

    expect(decoded.type).toBe("clipboard-plan-paste-success");
    if (decoded.type !== "clipboard-plan-paste-success" || !decoded.result.ok) {
      throw new Error("Expected a successful paste plan.");
    }
    const element = decoded.result.value.elements[0];
    expect(element?.kind).toBe("stroke");
    if (element?.kind !== "stroke") throw new Error("Expected a stroke.");
    expect(Array.isArray(element.points)).toBe(true);
    expect(element.points).toEqual(STROKE.points);
  });
});
