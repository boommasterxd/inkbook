import { describe, expect, it } from "vitest";
import { FILE_SCHEMA_LIMITS } from "../../../../../../src/domain/schema/public";
import {
  encodeRuntimeRequest,
  encodeRuntimeRequestChunked,
  decodeRuntimeRequestChunked,
  decodeRuntimeResultChunked,
} from "../../../../../../src/persistence/worker/runtime/wire/wire-codec";
import { assertResultMatchesRequest } from "../../../../../../src/persistence/worker/runtime/bridge/request-result-validation";
import { serializeOneStrokeWorkerSnapshot } from "../../../../../fixtures/persistence/worker-bridge";
import { inspectTrustedSvgOutput } from "../../../../../../src/persistence/scheduling/trusted-svg-output";
import { createTestWorkScheduler } from "../../../../../fixtures/persistence/work-scheduler";
import { SafeStaticProof } from "../../../../../../src/persistence/serialization/input/safe-static-proof";

const identity = {
  sessionId: "geometry",
  workerEpoch: 1,
  operationId: 2,
  purpose: "preflight" as const,
};
function context() {
  return { signal: new AbortController().signal, checkpoint: () => undefined };
}

function encodeInputProof(type: "unlock" | "prepare-export-geometry", proof: SafeStaticProof) {
  const encoded = encodeRuntimeRequest({
    type,
    input: "<svg/>",
    safeStaticProof: proof,
    identity: { ...identity, purpose: type === "unlock" ? "unlock" : "preflight" },
  });
  const wire = structuredClone(encoded.value);
  if (wire.type !== "unlock" && wire.type !== "prepare-export-geometry")
    throw new Error("Wrong input channel.");
  return wire;
}

it("preserves known text-run counts and legacy unknown proofs through both input channels", async () => {
  for (const count of [undefined, 0, 2]) {
    for (const type of ["unlock", "prepare-export-geometry"] as const) {
      const proof =
        count === undefined
          ? SafeStaticProof.fromTrustedProducer("a".repeat(64), 6)
          : SafeStaticProof.fromTrustedProducer("a".repeat(64), 6, count);
      const wire = encodeInputProof(type, proof);
      if (count === undefined)
        expect(wire.trustedSafeStatic).not.toHaveProperty("unadjustedTextRuns");
      else expect(wire.trustedSafeStatic?.unadjustedTextRuns).toBe(count);
      const decoded = await decodeRuntimeRequestChunked(wire, context());
      if (decoded.type !== "unlock" && decoded.type !== "prepare-export-geometry")
        throw new Error("Wrong input channel.");
      expect(SafeStaticProof.isAuthentic(decoded.safeStaticProof)).toBe(true);
      expect(decoded.safeStaticProof?.unadjustedTextRuns).toBe(count);
    }
  }
});

it("rejects negative and nonfinite text-run counts received on either input channel", async () => {
  for (const count of [-1, Number.NaN]) {
    for (const type of ["unlock", "prepare-export-geometry"] as const) {
      const proof = SafeStaticProof.fromTrustedProducer("a".repeat(64), 6, 0);
      const wire = encodeInputProof(type, proof);
      Object.assign(wire.trustedSafeStatic!, { unadjustedTextRuns: count });
      await expect(decodeRuntimeRequestChunked(wire, context())).rejects.toThrow(TypeError);
    }
  }
});

describe("export geometry worker wire", () => {
  it("encodes string input cooperatively without splitting a surrogate pair", async () => {
    const input = "a".repeat(16 * 1024 - 1) + "🖋" + "ü";
    const encoded = await encodeRuntimeRequestChunked(
      { type: "prepare-export-geometry", identity, input },
      context(),
    );
    expect(encoded.transfer).toHaveLength(1);
    const decoded = await decodeRuntimeRequestChunked(
      structuredClone(encoded.value, { transfer: [...encoded.transfer] }),
      context(),
    );
    if (decoded.type !== "prepare-export-geometry") throw new Error("Wrong request type.");
    expect(new TextDecoder().decode(decoded.input as Uint8Array)).toBe(input);
  });
  it("transfers owned input bytes and reconstructs authentic safe-static evidence", async () => {
    const serialized = serializeOneStrokeWorkerSnapshot();
    const trusted = await inspectTrustedSvgOutput(serialized.svg, undefined, {
      workScheduler: createTestWorkScheduler(),
    });
    const input = new TextEncoder().encode(serialized.svg);
    const encoded = encodeRuntimeRequest({
      type: "prepare-export-geometry",
      identity,
      input,
      safeStaticProof: trusted.safeStaticProof,
    });
    const wire = structuredClone(encoded.value, { transfer: [...encoded.transfer] });
    expect(input.byteLength).toBe(0);
    const decoded = await decodeRuntimeRequestChunked(wire, context());
    expect(decoded.type).toBe("prepare-export-geometry");
    if (decoded.type !== "prepare-export-geometry") throw new Error("Wrong request type.");
    expect(decoded.safeStaticProof?.outputHash).toBe(trusted.outputHash);
    expect(new TextDecoder().decode(decoded.input as Uint8Array)).toBe(serialized.svg);
  });

  it("preserves the complete input when an authentic allocation hint is stale", async () => {
    const input = "a".repeat(16 * 1024 - 1) + "🖋" + "ü";
    const bytes = new TextEncoder().encode(input);
    for (const totalBytes of [bytes.byteLength - 1, bytes.byteLength + 1]) {
      const encoded = await encodeRuntimeRequestChunked(
        {
          type: "prepare-export-geometry",
          identity,
          input,
          safeStaticProof: SafeStaticProof.fromTrustedProducer("a".repeat(64), totalBytes),
        },
        context(),
      );
      const decoded = await decodeRuntimeRequestChunked(
        structuredClone(encoded.value, { transfer: [...encoded.transfer] }),
        context(),
      );
      if (decoded.type !== "prepare-export-geometry") throw new Error("Wrong request type.");
      expect(decoded.input).toEqual(bytes);
    }
  });

  it("cancels hinted encoding before a partial buffer can cross the channel", async () => {
    const controller = new AbortController();
    await expect(
      encodeRuntimeRequestChunked(
        {
          type: "prepare-export-geometry",
          identity,
          input: "a".repeat(32 * 1024),
          safeStaticProof: SafeStaticProof.fromTrustedProducer("a".repeat(64), 32 * 1024),
        },
        {
          signal: controller.signal,
          checkpoint: () => {
            controller.abort();
            return undefined;
          },
        },
      ),
    ).rejects.toThrow();
  });
});

describe("export geometry wire validation", () => {
  it("rejects wrong request purposes and wrong response identities", async () => {
    expect(() =>
      encodeRuntimeRequest({
        type: "prepare-export-geometry",
        identity: { ...identity, purpose: "unlock" },
        input: "",
      }),
    ).toThrow();
    const request = { type: "prepare-export-geometry" as const, identity, input: "" };
    await expect(
      assertResultMatchesRequest(
        request,
        {
          type: "prepare-export-geometry-success",
          identity: { ...identity, operationId: 3 },
          intervals: [],
        },
        context(),
      ),
    ).rejects.toThrow();
  });

  it("accepts bounded numeric geometry and the explicit invalid-metadata fallback", async () => {
    for (const intervals of [undefined, [{ minY: -2, maxY: 10 }]]) {
      const result = { type: "prepare-export-geometry-success", identity, intervals };
      expect(await decodeRuntimeResultChunked(result, context())).toEqual(result);
    }
  });

  it("rejects oversized, nonfinite and reversed geometry before index publication", async () => {
    for (const intervals of [
      Array.from({ length: FILE_SCHEMA_LIMITS.elements + 1 }, () => ({ minY: 0, maxY: 1 })),
      [{ minY: NaN, maxY: 1 }],
      [{ minY: 0, maxY: Infinity }],
      [{ minY: 2, maxY: 1 }],
    ]) {
      await expect(
        decodeRuntimeResultChunked(
          { type: "prepare-export-geometry-success", identity, intervals },
          context(),
        ),
      ).rejects.toThrow();
    }
  });

  it("cancels interval adoption through central checkpoints", async () => {
    const abort = new AbortController();
    await expect(
      decodeRuntimeResultChunked(
        {
          type: "prepare-export-geometry-success",
          identity,
          intervals: [
            { minY: 0, maxY: 10 },
            { minY: 20, maxY: 30 },
          ],
        },
        {
          signal: abort.signal,
          checkpoint: () => {
            abort.abort();
          },
        },
      ),
    ).rejects.toThrow();
  });
});
