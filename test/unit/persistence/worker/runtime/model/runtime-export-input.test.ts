import { afterEach, describe, expect, it, vi } from "vitest";
import { SafeStaticProof } from "../../../../../../src/persistence/serialization/input/safe-static-proof";
import { ChunkedInkbookInputParser } from "../../../../../../src/persistence/serialization/input/chunked-input-codec";
import { ChunkedInputHash } from "../../../../../../src/persistence/serialization/input/chunked-input-hash";
import type { DocumentHashPort } from "../../../../../../src/persistence/serialization/sha256";
import { parseExportGeometryInput } from "../../../../../../src/persistence/worker/runtime/model/runtime-export-input";
import type { PrepareExportGeometryRequest } from "../../../../../../src/persistence/worker/runtime/types";
import { serializeOneStrokeWorkerSnapshot } from "../../../../../fixtures/persistence/worker-bridge";

const serialized = serializeOneStrokeWorkerSnapshot();
const proof = SafeStaticProof.fromTrustedProducer(serialized.hash, serialized.totalBytes);
const identity = {
  sessionId: "export",
  workerEpoch: 1,
  operationId: 1,
  purpose: "preflight" as const,
};

function request(
  input: string | Uint8Array,
  safeStaticProof = proof,
): PrepareExportGeometryRequest {
  return { type: "prepare-export-geometry", identity, input, safeStaticProof };
}

afterEach(() => vi.restoreAllMocks());

describe("export input proof binding", () => {
  it("accepts complete actual bytes and falls back safely when authentic evidence is stale", async () => {
    const matching = await parseExportGeometryInput(request(serialized.svg));
    expect(matching.ok && matching.value.hash).toBe(serialized.hash);
    const stale = SafeStaticProof.fromTrustedProducer("a".repeat(64), serialized.totalBytes);
    const changedHash = await parseExportGeometryInput(request(serialized.svg, stale));
    expect(changedHash.ok && changedHash.value.hash).toBe(serialized.hash);
    const changedLength = await parseExportGeometryInput(
      request(new TextEncoder().encode(serialized.svg + " ")),
    );
    expect(changedLength.ok).toBe(true);
  });

  it("uses one terminal digest of owned bytes and safely retries stale evidence", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    const release = vi.spyOn(ChunkedInputHash.prototype, "release");
    const input = new TextEncoder().encode(serialized.svg);
    const matching = await parseExportGeometryInput(request(input));
    expect(matching.ok && matching.value.hash).toBe(serialized.hash);
    expect(digest).toHaveBeenCalledTimes(1);
    expect(digest.mock.calls[0]?.[1]).toEqual(input);
    expect((digest.mock.calls[0]?.[1] as Uint8Array).buffer).not.toBe(input.buffer);
    const stale = SafeStaticProof.fromTrustedProducer("a".repeat(64), serialized.totalBytes);
    const changed = await parseExportGeometryInput(request(input, stale));
    expect(changed.ok && changed.value.hash).toBe(serialized.hash);
    expect(digest).toHaveBeenCalledTimes(2);
    for (const hash of release.mock.contexts) expect(hash).toHaveProperty("retainedBytes", 0);
  });

  it("does not publish geometry for modified static markup or inconsistent metadata", async () => {
    const invalidStatic = serialized.svg.replace("<path ", "<evil ");
    expect(invalidStatic).not.toBe(serialized.svg);
    const staticResult = await parseExportGeometryInput(
      request(new TextEncoder().encode(invalidStatic)),
    );
    expect(staticResult.ok).toBe(false);
    const invalidMetadata = serialized.svg.replace(
      `"revision":${serialized.snapshot.revision}`,
      `"revision":${serialized.snapshot.revision + 1}`,
    );
    expect(invalidMetadata).not.toBe(serialized.svg);
    expect(
      (await parseExportGeometryInput(request(new TextEncoder().encode(invalidMetadata)))).ok,
    ).toBe(false);
  });

  it("hashes owned chunks and rejects mutation of unread input at a checkpoint", async () => {
    const input = new TextEncoder().encode(serialized.svg);
    const pathOffset = serialized.svg.indexOf("<path ");
    expect(pathOffset).toBeGreaterThan(32);
    let changed = false;
    const result = await parseExportGeometryInput(request(input), {
      checkpoint: () => {
        if (!changed) {
          input.set(new TextEncoder().encode("<evil "), pathOffset);
          changed = true;
        }
        return undefined;
      },
      signal: new AbortController().signal,
      workProfile: { inputByteLimit: 32, nodeLimit: 1, outputByteLimit: 1 },
    });
    expect(changed).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("rejects a forged proof before parsing", async () => {
    const writes = vi.spyOn(ChunkedInkbookInputParser.prototype, "write");
    await expect(
      parseExportGeometryInput(
        request(serialized.svg, Object.create(SafeStaticProof.prototype) as SafeStaticProof),
      ),
    ).rejects.toThrow(TypeError);
    expect(writes).not.toHaveBeenCalled();
  });
});

describe("export input cancellation and capacity", () => {
  it("does not retry an aborted candidate and releases its retained input", async () => {
    const abort = new AbortController();
    const writes = vi.spyOn(ChunkedInkbookInputParser.prototype, "write");
    await expect(
      parseExportGeometryInput(request(serialized.svg), {
        checkpoint: () => {
          abort.abort();
          return undefined;
        },
        signal: abort.signal,
      }),
    ).rejects.toThrow();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.contexts[0]).toHaveProperty("retainedSampleEncodingBytes", 0);
  });

  it("finishes a rejected write before creating the full-validation fallback", async () => {
    const finish = vi.spyOn(ChunkedInkbookInputParser.prototype, "finish");
    expect((await parseExportGeometryInput(request("x".repeat(64 * 1024 + 1)))).ok).toBe(false);
    expect(finish).toHaveBeenCalledTimes(2);
    expect(new Set(finish.mock.contexts).size).toBe(2);
  });

  it("rejects cancellation during the terminal digest without retrying or retaining its buffer", async () => {
    const abort = new AbortController();
    let releaseDigest!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDigest = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      started();
      await gate;
      return nativeDigest(algorithm, data);
    });
    const finish = vi.spyOn(ChunkedInkbookInputParser.prototype, "finish");
    const release = vi.spyOn(ChunkedInputHash.prototype, "release");
    const pending = parseExportGeometryInput(request(new TextEncoder().encode(serialized.svg)), {
      checkpoint: () => undefined,
      signal: abort.signal,
    });
    const rejected = expect(pending).rejects.toThrow();
    await entered;
    abort.abort();
    releaseDigest();
    await rejected;
    expect(finish).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalled();
    for (const hash of release.mock.contexts) expect(hash).toHaveProperty("retainedBytes", 0);
  });

  it("reports wrong collector capacity as a codec failure and releases both short and long buffers", async () => {
    const input = new TextEncoder().encode(serialized.svg);
    const release = vi.spyOn(ChunkedInputHash.prototype, "release");
    for (const delta of [-1, 1]) {
      const parser = new ChunkedInkbookInputParser({
        nativeExportHash: true,
        safeStaticProof: SafeStaticProof.fromTrustedProducer(serialized.hash, input.length + delta),
        staticValidation: "safe",
      });
      const written = await parser.write(input);
      expect(written.ok).toBe(delta > 0);
      expect(await parser.finish()).toMatchObject({ ok: false, error: { code: "invalid-svg" } });
    }
    for (const hash of release.mock.contexts) expect(hash).toHaveProperty("retainedBytes", 0);
    expect((await parseExportGeometryInput(request(input))).ok).toBe(true);
  });
});

describe("export input ownership boundaries", () => {
  it("captures hash options before caller mutation can alter proof authorization", async () => {
    const config: {
      hasher?: DocumentHashPort;
      safeStaticProof: SafeStaticProof;
      staticValidation: "safe";
    } = {
      safeStaticProof: proof,
      staticValidation: "safe",
    };
    const parser = new ChunkedInkbookInputParser(config);
    const forged = vi.fn(() => proof.outputHash);
    config.hasher = { hash: forged };
    const changed = new TextEncoder().encode(serialized.svg.replace("<path ", "<evil "));
    await parser.write(changed);
    expect(await parser.finish()).toMatchObject({ ok: false, error: { code: "invalid-svg" } });
    expect(forged).not.toHaveBeenCalled();
  });

  it.each(["write", "finish"] as const)(
    "rejects overlapping native %s while copied input is decoding",
    async (operation) => {
      let releaseGate!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let blocked = false;
      const release = vi.spyOn(ChunkedInputHash.prototype, "release");
      const parser = new ChunkedInkbookInputParser({
        nativeExportHash: true,
        safeStaticProof: proof,
        staticValidation: "safe",
        inputSliceBytes: 32,
        checkpoint: () => {
          if (blocked) return undefined;
          blocked = true;
          entered();
          return gate;
        },
      });
      const writing = parser.write(new TextEncoder().encode(serialized.svg));
      await started;
      const conflicting =
        operation === "write" ? await parser.write(new Uint8Array()) : await parser.finish();
      expect(conflicting).toMatchObject({ ok: false, error: { code: "invalid-svg" } });
      releaseGate();
      expect(await writing).toMatchObject({ ok: false });
      if (operation === "write") expect((await parser.finish()).ok).toBe(false);
      for (const hash of release.mock.contexts) expect(hash).toHaveProperty("retainedBytes", 0);
    },
  );
});
