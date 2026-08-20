import { describe, expect, it } from "vitest";

import { encodeCanonicalJson } from "../../../src/domain/codecs";
import {
  createAnnotationHistoryEntryV1,
  createAnnotationOperationV1,
  createHistoryEpoch,
  parseHistoryEntryId,
  parseOperationId,
} from "../../../src/domain/operations";
import {
  parseHostEffectId,
  parseRecoveryAttemptId,
  parseViewId,
} from "../../../src/application/note-session";
import type { ActionableHistoryEntrySnapshotV1 } from "../../../src/application/host-history";
import {
  DEFAULT_HOST_HISTORY_LIMITS,
  fitsLimits,
  isValidEnvelope,
} from "../../../src/application/host-history/validation";
import { resolveLimits } from "../../../src/application/host-history/value-objects";
import { rectangleElement } from "../../domain/model/support";

describe("Host history payload limits", () => {
  it("counts ASCII, multibyte, and astral payload bytes at exact limits", () => {
    const base = actionableEntry("view_ascii");
    for (const label of ["ascii", "é", "😀"]) {
      const candidate = Object.freeze({
        ...base,
        ownerViewId: parseViewId(`view_${label}`),
      });
      const bytes = encodeCanonicalJson(candidate).byteLength;
      expect(
        fitsLimits([candidate], {
          maxActionableEntries: 1,
          maxPayloadBytes: bytes,
        }),
      ).toBe(true);
      expect(
        fitsLimits([candidate], {
          maxActionableEntries: 1,
          maxPayloadBytes: bytes - 1,
        }),
      ).toBe(false);
    }
  });
});

describe("Host history envelope validation", () => {
  it("rejects extra keys, accessors, and invalid directions without getters", () => {
    const envelope = {
      direction: "forward",
      effectId: "eff_00000000000000000000000000",
      historyEntryId: "he_00000000000000000000000000",
      historyEpoch: 1,
      noteIdentity: {
        vaultIdHint: "vault",
        vaultRelativeMarkdownPath: "Notes/history.md",
      },
    };
    expect(isValidEnvelope({ ...envelope, extra: true })).toBe(false);
    expect(isValidEnvelope({ ...envelope, direction: "sideways" })).toBe(false);

    let getterRead = false;
    const accessorEnvelope = Object.defineProperties(
      {},
      {
        direction: { enumerable: true, value: "forward" },
        effectId: {
          enumerable: true,
          get: () => {
            getterRead = true;
            return envelope.effectId;
          },
        },
        historyEntryId: { enumerable: true, value: envelope.historyEntryId },
        historyEpoch: { enumerable: true, value: envelope.historyEpoch },
        noteIdentity: { enumerable: true, value: envelope.noteIdentity },
      },
    );
    expect(isValidEnvelope(accessorEnvelope)).toBe(false);
    expect(getterRead).toBe(false);
  });
});

describe("Host history limits", () => {
  it("accepts defaults and lower limits, and rejects invalid bounds", () => {
    expect(resolveLimits(undefined)).toEqual(DEFAULT_HOST_HISTORY_LIMITS);
    expect(
      resolveLimits({ maxActionableEntries: 1, maxPayloadBytes: 1 }),
    ).toEqual({ maxActionableEntries: 1, maxPayloadBytes: 1 });
    expect(() => resolveLimits({ maxActionableEntries: 0 })).toThrow();
    expect(() =>
      resolveLimits({
        maxActionableEntries:
          DEFAULT_HOST_HISTORY_LIMITS.maxActionableEntries + 1,
      }),
    ).toThrow();
    expect(() =>
      resolveLimits({
        maxPayloadBytes: DEFAULT_HOST_HISTORY_LIMITS.maxPayloadBytes + 1,
      }),
    ).toThrow();
    expect(() => resolveLimits({ maxPayloadBytes: Number.NaN })).toThrow();
  });
});

function actionableEntry(
  ownerViewId: string,
): ActionableHistoryEntrySnapshotV1 {
  const element = rectangleElement(0);
  const value = {
    binding: element.binding,
    elementId: element.elementId,
    geometry: element.geometry,
    kind: element.kind,
    style: element.style,
  };
  const historyEntry = createAnnotationHistoryEntryV1({
    forward: {
      elements: [value],
      kind: "create-elements",
      placement: {
        movedElementIds: [element.elementId],
        predecessorId: null,
        successorId: null,
      },
    },
    historyEntryId: parseHistoryEntryId("he_00000000000000000000000000"),
    historyEpoch: createHistoryEpoch(1),
  });
  if (!historyEntry.ok) throw new Error("History fixture is invalid.");
  const operation = createAnnotationOperationV1({
    direction: "forward",
    expectedSceneRevision: 0,
    historyEntryId: historyEntry.value.historyEntryId,
    historyEpoch: historyEntry.value.historyEpoch,
    operationId: parseOperationId("op_00000000000000000000000000"),
    patch: historyEntry.value.forward,
  });
  if (!operation.ok) throw new Error("Operation fixture is invalid.");
  return Object.freeze({
    effectId: parseHostEffectId("eff_00000000000000000000000000"),
    historyEntry: historyEntry.value,
    lifecycle: "admitting",
    noteIdentity: {
      vaultIdHint: "vault",
      vaultRelativeMarkdownPath: "Notes/history.md",
    },
    ownerViewId: parseViewId(ownerViewId),
    preparedForward: operation.value,
    recoveryAttemptId: parseRecoveryAttemptId("ra_00000000000000000000000000"),
  });
}
