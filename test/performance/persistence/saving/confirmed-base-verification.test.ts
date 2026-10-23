import { afterEach, describe, expect, it, vi } from "vitest";
import * as safeSvg from "../../../../src/persistence/documents/safe-svg-validator";
import * as pressure from "../../../../src/domain/geometry/pressure/pressure-union";
import { verifyExactWorkerContent } from "../../../../src/persistence/saving/autosave/trusted-verification";
import { hashConfirmedSvgContent } from "../../../../src/persistence/scheduling/trusted-svg-output";
import { ChunkedSha256 } from "../../../../src/persistence/serialization/chunked-output-sha256";
import { sha256Hex } from "../../../../src/persistence/serialization/sha256";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/document-codec";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/public";
import { createStandardPersistenceFixture, STANDARD_STROKES } from "../fixtures";

const identity = {
  operationId: 1,
  purpose: "preflight" as const,
  sessionId: "base",
  workerEpoch: 1,
};
afterEach(() => vi.restoreAllMocks());

describe("confirmed persisted base verification work", () => {
  it("checks all 10k-stroke source bytes in the worker without Main encoding, hashing, or SVG scans", async () => {
    const snapshot = createStandardPersistenceFixture(2);
    const serialized = serializeInkbookDocument(snapshot);
    if (!serialized.ok) throw new Error(serialized.error.code);
    const runtime = new DocumentWorkerRuntime({ sessionId: "base", workerEpoch: 1 });
    let workerActive = false;
    let mainEncodedBytes = 0;
    let workerEncodedBytes = 0;
    const originalExecute = runtime.execute.bind(runtime);
    const execute = vi.spyOn(runtime, "execute").mockImplementation(async (request) => {
      workerActive = true;
      try {
        return await originalExecute(request);
      } finally {
        workerActive = false;
      }
    });
    const originalEncode = new TextEncoder().encode.bind(new TextEncoder());
    vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(function (
      this: TextEncoder,
      input,
    ) {
      const result = originalEncode(input);
      if (workerActive) workerEncodedBytes += result.byteLength;
      else mainEncodedBytes += result.byteLength;
      return result;
    });
    const encoder = new TextEncoder();
    const originalEncodeInto = encoder.encodeInto.bind(encoder);
    vi.spyOn(TextEncoder.prototype, "encodeInto").mockImplementation((input, destination) => {
      const result = originalEncodeInto(input, destination);
      if (workerActive) workerEncodedBytes += result.written;
      else mainEncodedBytes += result.written;
      return result;
    });
    const scan = vi.spyOn(safeSvg, "validateSafeSvgSteps");
    const geometry = vi.spyOn(pressure, "iteratePressureUnion");
    const hash = vi.spyOn(ChunkedSha256.prototype, "update");
    const nativeHash = vi.spyOn(crypto.subtle, "digest");
    const confirmedBase = {
      outputHash: serialized.value.hash,
      revision: 2,
      type: "confirmed" as const,
    };
    await expect(
      verifyExactWorkerContent(runtime, identity, serialized.value.svg, "editable", {
        confirmedBase,
        expectedBytes: serialized.value.totalBytes,
      }),
    ).resolves.toEqual(confirmedBase);
    const expectedBytes = serialized.value.totalBytes;
    expect(nativeHash).toHaveBeenCalledExactlyOnceWith("SHA-256", expect.any(Uint8Array));
    expect(nativeHash.mock.calls[0]![1].byteLength).toBe(expectedBytes);
    expect(mainEncodedBytes).toBe(0);
    expect(workerEncodedBytes).toBe(expectedBytes);
    expect(hash).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(scan).not.toHaveBeenCalled();
    expect(geometry).not.toHaveBeenCalled();
    // An appended byte must take the normal validation path, even with the same revision.
    await expect(
      verifyExactWorkerContent(runtime, identity, serialized.value.svg + " ", "editable", {
        confirmedBase,
      }),
    ).resolves.toMatchObject({ revision: 2, type: "confirmed" });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(mainEncodedBytes).toBe(0);
    expect(scan).not.toHaveBeenCalled();
    // Unknown exact bytes require one full canonical comparison: each stroke plus
    // the shared template's validation derivation, with no duplicate comparison.
    expect(geometry.mock.calls.length).toBeGreaterThan(0);
    expect(geometry.mock.calls.length).toBeLessThanOrEqual(STANDARD_STROKES + 1);
    expect(nativeHash).toHaveBeenCalledTimes(2);
    runtime.terminate();
  }, 120_000);
});

describe("confirmed hashing fallback work", () => {
  it("keeps over-capacity files on bounded streaming hashing", async () => {
    const source = "x".repeat(20 * 1024 * 1024 + 1);
    const nativeHash = vi.spyOn(crypto.subtle, "digest");
    const hash = vi.spyOn(ChunkedSha256.prototype, "update");
    await expect(hashConfirmedSvgContent(source)).resolves.toMatch(/^[0-9a-f]{64}$/u);
    expect(nativeHash).not.toHaveBeenCalled();
    expect(hash.mock.calls.reduce((bytes, [chunk]) => bytes + chunk.byteLength, 0)).toBe(
      source.length,
    );
    expect(hash.mock.calls.every(([chunk]) => chunk.byteLength <= 64 * 1024)).toBe(true);
  });

  it("falls back to exact streaming hashing when UTF-8 bytes exceed the native cap", async () => {
    const source = "ä".repeat(11 * 1024 * 1024);
    const expected = sha256Hex(source);
    const nativeHash = vi.spyOn(crypto.subtle, "digest");
    const hash = vi.spyOn(ChunkedSha256.prototype, "update");
    await expect(hashConfirmedSvgContent(source)).resolves.toBe(expected);
    expect(nativeHash).not.toHaveBeenCalled();
    expect(hash.mock.calls.reduce((bytes, [chunk]) => bytes + chunk.byteLength, 0)).toBe(
      22 * 1024 * 1024,
    );
    expect(hash.mock.calls.every(([chunk]) => chunk.byteLength <= 3 * 64 * 1024)).toBe(true);
  });
});
