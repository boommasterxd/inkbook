import { describe, expect, it } from "vitest";

import {
  decodeRuntimeResult,
  decodeRuntimeResultChunked,
  encodeRuntimeResult,
  encodeRuntimeResultChunked,
} from "../../../../../src/persistence/worker/runtime/wire-codec";
import { STROKE } from "./fixtures";
import { maximumLengthHighlighter } from "../../../domain/store/fixtures";
import type { PlanClipboardPasteRuntimeSuccess } from "../../../../../src/persistence/worker/runtime/types";

describe("clipboard paste-plan wire codec", () => {
  it("slices wire sample packing and adoption and cancels both before publication", async () => {
    const element = maximumLengthHighlighter();
    const result: PlanClipboardPasteRuntimeSuccess = {
      identity: { operationId: 1, purpose: "clipboard", sessionId: "session-a", workerEpoch: 1 },
      type: "clipboard-plan-paste-success",
      result: {
        ok: true,
        value: {
          activateTool: "select",
          commandTimestamp: 1,
          contentIds: [],
          elements: [element],
          highlightIds: [element.id],
          insertAtBandFront: true,
          repeatState: { fingerprint: "stroke", pasteCount: 1 },
          selectedIds: [element.id],
          translation: { x: 0, y: 0 },
        },
      },
    };
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
