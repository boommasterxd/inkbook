import { describe, expect, it } from "vitest";

import {
  decodeRuntimeResult,
  encodeRuntimeResult,
} from "../../../../../src/persistence/worker/runtime/wire-codec";
import { STROKE } from "./fixtures";

describe("clipboard paste-plan wire codec", () => {
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
