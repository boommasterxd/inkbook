import { describe, expect, it } from "vitest";

import {
  validateInkSnapshotV1,
  type StrokeElementV1,
} from "../../../../../src/domain/schema/public";
import { encodeRuntimeSelection } from "../../../../../src/persistence/clipboard/codec";
import { CLIPBOARD_LIMITS } from "../../../../../src/persistence/clipboard/constants";
import { INKBOOK_CLIPBOARD_TEXT_PREFIX } from "../../../../../src/persistence/clipboard/constants";
import {
  deriveDocumentIntegrityManifest,
  serializeInkbookDocument,
} from "../../../../../src/persistence/serialization/public";
import { sha256Hex } from "../../../../../src/persistence/serialization/sha256";
import {
  decodeRuntimeResultChunked,
  encodeRuntimeResultChunked,
} from "../../../../../src/persistence/worker/runtime/wire-codec";
import {
  decodeRuntimeRequestChunked,
  decodeRuntimeResult,
  decodeUnlockBatch,
  encodeRuntimeRequest,
  encodeRuntimeRequestChunked,
  encodeRuntimeResult,
  encodeUnlockBatchChunked,
} from "../../../../../src/persistence/worker/runtime/wire-codec";
import {
  packElements,
  unpackElements,
} from "../../../../../src/persistence/worker/runtime/element-wire-codec";
import { snapshot, STROKE } from "./fixtures";

function createWireContext() {
  return { checkpoint: () => undefined, signal: new AbortController().signal };
}

const clipboardIdentity = (operationId: number) => ({
  operationId,
  purpose: "clipboard" as const,
  sessionId: "session-a",
  workerEpoch: 2,
});

describe("document worker wire codec", () => {
  it("round-trips bounded full and incremental model synchronization requests", async () => {
    const full = await encodeRuntimeRequestChunked(
      {
        baseModelRevision: null,
        identity: clipboardIdentity(7),
        modelRevision: 0,
        snapshot: snapshot(),
        type: "model-sync-full",
      },
      createWireContext(),
    );
    expect(full.value.type).toBe("model-sync-full-wire");
    expect(await decodeRuntimeRequestChunked(full.value, createWireContext())).toMatchObject({
      modelRevision: 0,
      snapshot: { revision: 0 },
      type: "model-sync-full",
    });

    const incremental = encodeRuntimeRequest({
      baseModelRevision: 0,
      changedElementDerivations: [validatedElementDerivation(STROKE)],
      changedElements: [STROKE],
      identity: clipboardIdentity(8),
      modelRevision: 1,
      type: "model-sync-incremental",
    });
    expect(incremental.value.type).toBe("model-sync-incremental-wire");
    expect(await decodeRuntimeRequestChunked(incremental.value, createWireContext())).toMatchObject(
      {
        changedElementDerivations: [{ elementId: STROKE.id }],
        changedElements: [{ id: STROKE.id }],
        modelRevision: 1,
        type: "model-sync-incremental",
      },
    );
    expect(STROKE.points).toEqual([10, 10, 0.5, 20, 20, 1]);
  });

  it("packs copied stroke buffers without detaching editor-owned arrays", () => {
    const document = snapshot();
    const packed = packElements([STROKE, ...document.elements]);
    const transferred = structuredClone(packed, {
      transfer: packed.pointBuffers.map(({ buffer }) => buffer as ArrayBuffer),
    });

    expect(STROKE.points).toEqual([10, 10, 0.5, 20, 20, 1]);
    expect(packed.pointBuffers[0]?.byteLength).toBe(0);
    const unpacked = unpackElements(transferred);
    expect(unpacked).toHaveLength(1 + document.elements.length);
    const transferredStroke = unpacked[0];
    expect(transferredStroke?.kind).toBe("stroke");
    if (transferredStroke?.kind !== "stroke") throw new Error("Expected a stroke.");
    expect(Array.from(transferredStroke.points)).toEqual(STROKE.points);
    expect(transferredStroke.points).toBeInstanceOf(Float64Array);
    expect((transferredStroke.points as unknown as Float64Array).buffer).toBe(
      transferred.pointBuffers[0]?.buffer,
    );
  });

  it("round-trips full requests and transferable UTF-8 export results", async () => {
    const request = encodeRuntimeRequest({
      baseModelRevision: null,
      exportGeneration: 4,
      modelRevision: 0,
      sessionId: "session-a",
      snapshot: snapshot(),
      type: "export-full",
      workerEpoch: 2,
    });
    expect(request.value.type).toBe("export-full-wire");
    expect(await decodeRuntimeRequestChunked(request.value, createWireContext())).toMatchObject({
      exportGeneration: 4,
      snapshot: { revision: 0 },
      type: "export-full",
    });

    const serialized = serializeInkbookDocument(snapshot());
    if (!serialized.ok) throw new Error(serialized.error.code);
    const result = encodeRuntimeResult(exportSuccess(serialized.value));
    expect(result.transfer).toHaveLength(1);
    const decoded = decodeRuntimeResult(result.value);
    expect(decoded.type).toBe("export-success");
    if (decoded.type === "export-success") {
      expect(decoded.output).toBe(serialized.value.svg);
    }
  });
});

describe("document worker export wire scheduling", () => {
  it("encodes transferable UTF-8 output in cancellable worker slices", async () => {
    const serialized = serializeInkbookDocument(snapshot());
    if (!serialized.ok) throw new Error(serialized.error.code);
    let checkpoints = 0;
    const encoded = await encodeRuntimeResultChunked(exportSuccess(serialized.value), {
      checkpoint: async () => {
        checkpoints += 1;
      },
      signal: new AbortController().signal,
    });

    expect(checkpoints).toBe(1);
    expect(encoded.value.type).toBe("export-success-wire");
    if (encoded.value.type !== "export-success-wire") throw new Error("Expected export output.");
    expect(encoded.transfer).toEqual([encoded.value.output.buffer]);
    expect(decodeRuntimeResult(encoded.value)).toMatchObject({ type: "export-success" });
  });
});

function exportSuccess(
  serialized: Extract<ReturnType<typeof serializeInkbookDocument>, { readonly ok: true }>["value"],
) {
  return {
    exportGeneration: 4,
    integrityManifest: deriveDocumentIntegrityManifest(serialized.snapshot),
    modelRevision: 0,
    output: serialized.svg,
    outputHash: serialized.hash,
    sessionId: "session-a",
    type: "export-success" as const,
    workerEpoch: 2,
  };
}

describe("document worker clipboard wire codec", () => {
  it("transfers one canonical clipboard text and reconstructs write aliases", () => {
    const selection = encodeRuntimeSelection([STROKE], new Set([STROKE.id]));
    if (!selection.ok) throw new Error(selection.error.code);
    const encoded = encodeRuntimeResult({
      identity: clipboardIdentity(1),
      result: selection,
      type: "clipboard-encode-success",
    });

    expect(encoded.transfer).toHaveLength(1);
    expect(STROKE.points).toEqual([10, 10, 0.5, 20, 20, 1]);
    expect(encoded.value.type).toBe("clipboard-encode-success-wire");
    if (encoded.value.type !== "clipboard-encode-success-wire" || !encoded.value.result.ok) {
      throw new Error("Expected an encoded clipboard wire result.");
    }
    expect(Object.keys(encoded.value.result.value).sort()).toEqual(["byteLength", "canonicalText"]);
    const received = structuredClone(encoded.value, { transfer: [...encoded.transfer] });
    expect(encoded.value.result.value.canonicalText.byteLength).toBe(0);
    expect(decodeRuntimeResult(received)).toMatchObject({
      result: {
        ok: true,
        value: {
          customText: selection.value.customText,
          plainText: selection.value.plainText,
        },
      },
      type: "clipboard-encode-success",
    });
  });

  it("adopts transferred decoded stroke buffers without a back-copy", () => {
    const selection = encodeRuntimeSelection([STROKE], new Set([STROKE.id]));
    if (!selection.ok) throw new Error(selection.error.code);
    const encoded = encodeRuntimeResult({
      identity: clipboardIdentity(2),
      result: { ok: true, value: { ...selection.value, source: "custom" } },
      type: "clipboard-decode-success",
    });
    expect(encoded.transfer).toHaveLength(2);
    const received = structuredClone(encoded.value, { transfer: [...encoded.transfer] });
    if (received.type !== "clipboard-decode-success-wire" || !received.result.ok) {
      throw new Error("Expected a decoded clipboard wire result.");
    }
    const transferredPoints = received.result.value.payload.pointBuffers[0];
    const decoded = decodeRuntimeResult(received);
    if (decoded.type !== "clipboard-decode-success" || !decoded.result.ok) {
      throw new Error("Expected a decoded clipboard result.");
    }
    const element = decoded.result.value.payload.elements[0]?.element;
    expect(element?.kind).toBe("stroke");
    if (element?.kind !== "stroke") throw new Error("Expected a stroke.");
    expect(element.points).toBeInstanceOf(Float64Array);
    expect((element.points as unknown as Float64Array).buffer).toBe(transferredPoints?.buffer);
    expect(STROKE.points).toEqual([10, 10, 0.5, 20, 20, 1]);
  });
});

describe("document worker clipboard wire adoption", () => {
  it("rejects clipboard wire text with mismatched or excessive byte lengths", () => {
    const wireResult = (byteLength: number) => ({
      identity: clipboardIdentity(1),
      result: { ok: true, value: { byteLength, canonicalText: new Uint8Array(1) } },
      type: "clipboard-encode-success-wire",
    });
    expect(() => decodeRuntimeResult(wireResult(2))).toThrow("byte length");
    expect(() => decodeRuntimeResult(wireResult(CLIPBOARD_LIMITS.totalInputBytes + 1))).toThrow(
      "limit",
    );
  });

  it("adopts canonical clipboard text in deterministic chunks", async () => {
    const customText = "a".repeat(5 * 1024 * 1024 + 1);
    const encoded = encodeRuntimeResult({
      identity: clipboardIdentity(3),
      result: {
        ok: true,
        value: {
          byteLength: customText.length,
          customText,
          plainText: `${INKBOOK_CLIPBOARD_TEXT_PREFIX}${customText}`,
        },
      },
      type: "clipboard-encode-success",
    });
    const received = structuredClone(encoded.value, { transfer: [...encoded.transfer] });
    let checkpoints = 0;
    const decoded = await decodeRuntimeResultChunked(received, {
      checkpoint: async () => {
        checkpoints += 1;
      },
      signal: new AbortController().signal,
    });

    expect(checkpoints).toBe(23);
    expect(decoded).toMatchObject({
      result: {
        ok: true,
        value: { customText, plainText: `${INKBOOK_CLIPBOARD_TEXT_PREFIX}${customText}` },
      },
      type: "clipboard-encode-success",
    });
  });

  it("checkpoints full-request packing without mutating the editor snapshot", async () => {
    const elements = Array.from({ length: 130 }, (_, index) => ({
      ...snapshot().elements[0]!,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    }));
    const document = { ...snapshot(), elements };
    let checkpoints = 0;
    const encoded = await encodeRuntimeRequestChunked(
      {
        baseModelRevision: null,
        exportGeneration: 1,
        modelRevision: 0,
        sessionId: "session-a",
        snapshot: document,
        type: "export-full",
        workerEpoch: 2,
      },
      {
        checkpoint: async () => {
          checkpoints += 1;
        },
        signal: new AbortController().signal,
      },
    );

    expect(checkpoints).toBe(2);
    expect(document.elements).toEqual(elements);
    const decoded = await decodeRuntimeRequestChunked(encoded.value, createWireContext());
    expect(decoded.type === "export-full" && decoded.snapshot.elements).toHaveLength(130);
  });
});

describe("document worker owned result adoption", () => {
  it("rejects malformed roots, manifests, hashes, and non-owned export output", () => {
    const unsafe = new TextEncoder().encode("<svg/>");
    const result = {
      exportGeneration: 1,
      integrityManifest: deriveDocumentIntegrityManifest(snapshot()),
      modelRevision: 0,
      output: unsafe,
      outputHash: sha256Hex(unsafe),
      sessionId: "session-a",
      type: "export-success-wire",
      workerEpoch: 2,
    };
    expect(() => decodeRuntimeResult(result)).toThrow("canonical SVG root");
    expect(() =>
      decodeRuntimeResult({
        ...result,
        integrityManifest: { ...result.integrityManifest, orderedIdDigest: "invalid" },
      }),
    ).toThrow("wire protocol");

    const serialized = serializeInkbookDocument(snapshot());
    if (!serialized.ok) throw new Error(serialized.error.code);
    const bytes = new TextEncoder().encode(serialized.value.svg);
    expect(() =>
      decodeRuntimeResult({
        ...result,
        output: bytes,
        outputHash: "invalid",
      }),
    ).toThrow("hash");

    const backing = new Uint8Array(bytes.byteLength + 1);
    backing.set(bytes, 1);
    expect(() =>
      decodeRuntimeResult({
        ...result,
        output: backing.subarray(1),
        outputHash: serialized.value.hash,
      }),
    ).toThrow("wire protocol");
  });

  it("rejects oversized paste plans before unpacking their records", () => {
    const element = snapshot().elements[0]!;
    expect(() =>
      decodeRuntimeResult({
        identity: clipboardIdentity(9),
        result: {
          ok: true,
          value: {
            elements: { pointBuffers: [], records: Array.from({ length: 5001 }, () => element) },
          },
        },
        type: "clipboard-plan-paste-success-wire",
      }),
    ).toThrow("element limit");
  });
});

describe("document worker wire validation", () => {
  it("rejects reused, missing, and malformed wire buffers", async () => {
    const packed = packElements([
      {
        createdAt: 1,
        id: "00000000-0000-4000-8000-000000000003",
        kind: "stroke",
        pivot: { x: 10, y: 10 },
        points: [10, 10, 1],
        rotation: 0,
        style: {
          color: { type: "theme-text" },
          opacity: 1,
          pressureEnabled: false,
          smoothing: 0.5,
          width: 2,
        },
        tool: "pen",
      },
    ]);
    const record = packed.records[0]!;
    expect(() => unpackElements({ pointBuffers: [], records: [record] })).toThrow("index");
    expect(() =>
      unpackElements({ pointBuffers: packed.pointBuffers, records: [record, record] }),
    ).toThrow("reused");
    packed.pointBuffers[0]![0] = Number.NaN;
    expect(() => unpackElements(packed)).toThrow();
    await expect(
      decodeRuntimeRequestChunked({ type: "unknown" }, createWireContext()),
    ).rejects.toThrow("wire protocol");
    expect(() => decodeRuntimeResult({ output: "text", type: "export-success-wire" })).toThrow(
      "wire protocol",
    );
  });
});

describe("document worker unlock batch wire validation", () => {
  it("round-trips bounded unlock batches with copied point transfers", async () => {
    const source = snapshot();
    const validation = validateInkSnapshotV1(source);
    if (!validation.ok) throw new Error(validation.error.message);
    const elements = source.elements;
    const derivations = validation.derivations.elements;
    const encoded = await encodeUnlockBatchChunked(
      {
        batchIndex: 0,
        derivations,
        elements,
        identity: {
          operationId: 1,
          purpose: "unlock",
          sessionId: "session-a",
          workerEpoch: 2,
        },
      },
      createWireContext(),
    );

    expect(decodeUnlockBatch(encoded.value)).toEqual({
      batchIndex: 0,
      derivations,
      elements,
      identity: {
        operationId: 1,
        purpose: "unlock",
        sessionId: "session-a",
        workerEpoch: 2,
      },
    });
    expect(() => decodeUnlockBatch({ ...encoded.value, batchIndex: -1 })).toThrow("wire protocol");
  });

  it("rejects unlock batches that exceed receiver element or point-buffer limits", async () => {
    const identity = {
      operationId: 1,
      purpose: "unlock" as const,
      sessionId: "session-a",
      workerEpoch: 2,
    };
    const tooManyElements = await encodeUnlockBatchChunked(
      {
        batchIndex: 0,
        derivations: Array.from({ length: 257 }, () => validatedSnapshotDerivations()[0]!),
        elements: Array.from({ length: 257 }, () => snapshot().elements[0]!),
        identity,
      },
      createWireContext(),
    );
    expect(() => decodeUnlockBatch(tooManyElements.value)).toThrow("element limit");

    const { points: _points, ...strokeRecord } = STROKE;
    const oversizedPointBuffer = {
      batchIndex: 0,
      derivations: [validatedSnapshotDerivations()[0]!],
      elements: {
        pointBuffers: [new Float64Array((4 * 1024 * 1024) / 8 + 1)],
        records: [{ ...strokeRecord, pointsBufferIndex: 0 }],
      },
      identity,
    };
    expect(() => decodeUnlockBatch(oversizedPointBuffer)).toThrow("point-buffer byte limit");

    const sharedBacking = new ArrayBuffer(6 * Float64Array.BYTES_PER_ELEMENT);
    const aliasedPointBuffers = {
      ...oversizedPointBuffer,
      elements: {
        pointBuffers: [new Float64Array(sharedBacking), new Float64Array(sharedBacking)],
        records: [
          { ...strokeRecord, pointsBufferIndex: 0 },
          { ...strokeRecord, pointsBufferIndex: 1 },
        ],
      },
    };
    expect(() => decodeUnlockBatch(aliasedPointBuffers)).toThrow("exclusive backing stores");
  });
});

function validatedSnapshotDerivations() {
  const validation = validateInkSnapshotV1(snapshot());
  if (!validation.ok) throw new Error(validation.error.message);
  return validation.derivations.elements;
}

function validatedElementDerivation(element: StrokeElementV1) {
  const validation = validateInkSnapshotV1({ ...snapshot(), elements: [element] });
  if (!validation.ok) throw new Error(validation.error.message);
  return validation.derivations.elements[0]!;
}
