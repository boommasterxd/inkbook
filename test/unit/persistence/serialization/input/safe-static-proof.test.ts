import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ChunkedInkbookInputParser } from "../../../../../src/persistence/serialization/input/chunked-input-codec";
import { SafeStaticProof } from "../../../../../src/persistence/serialization/input/safe-static-proof";
import { StreamingSafeStaticValidator } from "../../../../../src/persistence/serialization/input/streaming-safe-static";
import { inspectTrustedSvgOutput } from "../../../../../src/persistence/scheduling/trusted-svg-output";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/public";
import {
  encodeUnlockRequest,
  decodeUnlockRequest,
} from "../../../../../src/persistence/worker/runtime/wire/unlock-request-wire";
import { rewriteDocumentMetadata } from "../../../../fixtures/persistence/metadata-rewrite";
import { createSnapshot } from "../fixtures";
import { parseRuntimeInput } from "../../../../../src/persistence/worker/runtime/model/parse-runtime-input";
import { ChunkedSha256 } from "../../../../../src/persistence/serialization/chunked-output-sha256";
import { ChunkedInputHash } from "../../../../../src/persistence/serialization/input/chunked-input-hash";

let svg: string;
let proof: SafeStaticProof;
let expectedSnapshot: ReturnType<typeof createSnapshot>;

beforeAll(async () => {
  const serialized = serializeInkbookDocument(createSnapshot());
  if (!serialized.ok) throw new Error(serialized.error.code);
  svg = serialized.value.svg;
  expectedSnapshot = serialized.value.snapshot;
  proof = (await inspectTrustedSvgOutput(svg)).safeStaticProof;
});
afterEach(() => vi.restoreAllMocks());

async function parse(input: string, ownedProof = proof) {
  const parser = new ChunkedInkbookInputParser({
    staticValidation: "safe",
    safeStaticProof: ownedProof,
  });
  await parser.write(new TextEncoder().encode(input));
  return parser.finish();
}

describe("owned preview safe-static evidence", () => {
  it("keeps canonical verification strict even for owned safe divergent presentation", async () => {
    const changed = svg.replace("M0 0L2048.6", "M1 0L2048.6");
    const safeStaticProof = (await inspectTrustedSvgOutput(changed)).safeStaticProof;
    expect((await parse(changed, safeStaticProof)).ok).toBe(true);
    const strict = new ChunkedInkbookInputParser({ safeStaticProof });
    await strict.write(new TextEncoder().encode(changed));
    expect(await strict.finish()).toMatchObject({
      ok: false,
      error: { code: "static-path-mismatch" },
    });
  });

  it("skips the complete repeated static scan only for exact input bytes", async () => {
    const staticWrite = vi.spyOn(StreamingSafeStaticValidator.prototype, "write");
    expect((await parse(svg)).ok).toBe(true);
    expect(staticWrite).not.toHaveBeenCalled();
    const cold = new ChunkedInkbookInputParser({ staticValidation: "safe" });
    await cold.write(new TextEncoder().encode(svg));
    expect((await cold.finish()).ok).toBe(true);
    expect(staticWrite).toHaveBeenCalled();
  });

  it.each([
    (source: string) => source.replace("M0 0L2048.6", "M1 0L2048.6"),
    (source: string) => source.replace("</svg>", "<script/></svg>"),
    (source: string) => `${source} `,
  ])("fails closed for changed presentation or input size", async (change) => {
    expect(await parse(change(svg))).toMatchObject({ ok: false, error: { code: "invalid-svg" } });
  });
});

describe("safe-static proof trust and validation boundaries", () => {
  it.each([
    {
      change: (source: string) =>
        source.replace('data-inkbook-revision="7"', 'data-inkbook-revision="8"'),
      code: "revision-mismatch",
    },
    {
      change: (source: string) =>
        rewriteDocumentMetadata(
          source,
          (metadata) => metadata.replace('"revision":7', '"revision":8'),
          false,
        ),
      code: "invalid-svg",
    },
    {
      change: (source: string) =>
        rewriteDocumentMetadata(
          source,
          (metadata) => metadata.replace('"revision":7', '"revision":-1'),
          true,
        ),
      code: "snapshot-invalid",
    },
  ])(
    "validates authoritative metadata despite a complete safe preview ($code)",
    async ({ change, code }) => {
      const changed = change(svg);
      const preview = await inspectTrustedSvgOutput(changed);
      expect(await parse(changed, preview.safeStaticProof)).toMatchObject({
        ok: false,
        error: { code },
      });
    },
  );

  it("rejects structural and prototype forgeries and caller-controlled hashes", () => {
    const fake = Object.create(SafeStaticProof.prototype) as SafeStaticProof;
    expect(SafeStaticProof.isAuthentic(fake)).toBe(false);
    expect(() => new ChunkedInkbookInputParser({ safeStaticProof: fake })).toThrow(
      "owned validation",
    );
    expect(
      () =>
        new ChunkedInkbookInputParser({
          safeStaticProof: proof,
          hasher: { hash: () => proof.outputHash },
        }),
    ).toThrow("complete actual input");
    expect(() => SafeStaticProof.fromTrustedProducer("invalid", 1)).toThrow(TypeError);
    expect(() => SafeStaticProof.fromTrustedProducer(proof.outputHash, 0)).toThrow(TypeError);
  });

  it("preserves only scalar proof evidence across the owned worker wire", () => {
    const request = {
      type: "unlock" as const,
      input: new TextEncoder().encode(svg),
      safeStaticProof: proof,
      identity: { operationId: 1, purpose: "unlock" as const, sessionId: "test", workerEpoch: 1 },
    };
    const encoded = encodeUnlockRequest(request);
    expect(encoded.value).not.toHaveProperty("safeStaticProof");
    expect(encoded.value.trustedSafeStatic).toEqual({
      outputHash: proof.outputHash,
      totalBytes: proof.totalBytes,
      unadjustedTextRuns: proof.unadjustedTextRuns,
    });
    const received = decodeUnlockRequest(encoded.value).safeStaticProof;
    expect(SafeStaticProof.isAuthentic(received)).toBe(true);
    expect(received?.matches(proof.outputHash, proof.totalBytes)).toBe(true);
    expect(() =>
      encodeUnlockRequest({ ...request, safeStaticProof: {} as SafeStaticProof }),
    ).toThrow("owned safe SVG");
    expect(() =>
      decodeUnlockRequest(Object.assign(encoded.value, { safeStaticProof: proof })),
    ).toThrow("malformed");
  });

  it("prevents publication after cancellation during the hash checkpoint", async () => {
    const controller = new AbortController();
    let cancel = false;
    const parser = new ChunkedInkbookInputParser({
      staticValidation: "safe",
      safeStaticProof: proof,
      signal: controller.signal,
      checkpoint: () => {
        if (cancel) controller.abort();
        return undefined;
      },
    });
    await parser.write(new TextEncoder().encode(svg));
    cancel = true;
    await expect(parser.finish()).rejects.toMatchObject({ code: "input-cancelled" });
  });
});

describe("worker-owned preview bytes", () => {
  it.each([
    { kind: "worker", validation: "worker-safe" as const, expected: true },
    { kind: "fallback", validation: "safe" as const, expected: false },
    { kind: "shared", validation: "worker-safe" as const, expected: false },
    { kind: "subarray", validation: "worker-safe" as const, expected: false },
  ])(
    "preserves $kind byte ownership across the first digest",
    async ({ kind, validation, expected }) => {
      const input = previewInputBytes(kind);
      const subtle = crypto.subtle;
      const digest = subtle.digest.bind(subtle);
      let changed = false;
      const completeDigests: BufferSource[] = [];
      vi.spyOn(subtle, "digest").mockImplementation((algorithm, source) => {
        const pending = digest(algorithm, source);
        if (source.byteLength === input.byteLength) {
          completeDigests.push(source);
          if (!changed) {
            input[input.length - 1] = 0x20;
            changed = true;
          }
        }
        return pending;
      });
      const parsed = await parseRuntimeInput(
        input,
        undefined,
        undefined,
        validation,
        undefined,
        proof,
      );
      expect(changed).toBe(true);
      expect(completeDigests).toHaveLength(expected ? 1 : 2);
      if (expected)
        expect(parsed).toMatchObject({
          ok: true,
          value: { hash: proof.outputHash, snapshot: expectedSnapshot },
        });
      else expect(parsed).toMatchObject({ ok: false, error: { code: "invalid-svg" } });
    },
  );

  it("runs complete safe validation after an equally sized unsafe worker input misses its proof", async () => {
    const input = new TextEncoder().encode(svg.replace("</svg>", "</sVg>"));
    expect(input.byteLength).toBe(proof.totalBytes);
    const scan = vi.spyOn(StreamingSafeStaticValidator.prototype, "write");
    expect(
      await parseRuntimeInput(input, undefined, undefined, "worker-safe", undefined, proof),
    ).toMatchObject({ ok: false });
    expect(scan).toHaveBeenCalled();
  });

  it("rejects invalid authoritative metadata even when the worker input matches its preview", async () => {
    const changed = svg.replace('data-inkbook-revision="7"', 'data-inkbook-revision="8"');
    const candidate = (await inspectTrustedSvgOutput(changed)).safeStaticProof;
    const scan = vi.spyOn(StreamingSafeStaticValidator.prototype, "write");
    expect(
      await parseRuntimeInput(
        new TextEncoder().encode(changed),
        undefined,
        undefined,
        "worker-safe",
        undefined,
        candidate,
      ),
    ).toMatchObject({ ok: false, error: { code: "revision-mismatch" } });
    expect(scan).not.toHaveBeenCalled();
  });

  it("discards a worker candidate cancelled during the native digest before delivering metadata", async () => {
    const controller = new AbortController();
    const adopt = vi.fn();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, bytes) => {
      const result = await digest(algorithm, bytes);
      controller.abort();
      return result;
    });
    await expect(
      parseRuntimeInput(
        previewInputBytes("worker"),
        {
          checkpoint: () => undefined,
          signal: controller.signal,
        },
        adopt,
        "worker-safe",
        undefined,
        proof,
      ),
    ).rejects.toThrow();
    expect(adopt).not.toHaveBeenCalled();
  });
});

describe("executor preview candidate binding", () => {
  it.each(["string", "bytes"])(
    "binds fresh %s input before skipping the static scan",
    async (kind) => {
      const input = kind === "string" ? svg : new TextEncoder().encode(svg);
      const staticWrite = vi.spyOn(StreamingSafeStaticValidator.prototype, "write");
      const result = await parseRuntimeInput(input, undefined, undefined, "safe", undefined, proof);
      expect(result.ok).toBe(true);
      expect(staticWrite).not.toHaveBeenCalled();
    },
  );

  it.each([
    { change: (source: string) => source.replace("M0 0L2048.6", "M1 0L2048.6"), ok: true },
    { change: (source: string) => `${source} `, ok: true },
    { change: (source: string) => source.replace("</svg>", "<script/></svg>"), ok: false },
  ])("fully validates changed input on a candidate miss ($ok)", async ({ change, ok }) => {
    const staticWrite = vi.spyOn(StreamingSafeStaticValidator.prototype, "write");
    const result = await parseRuntimeInput(
      new TextEncoder().encode(change(svg)),
      undefined,
      undefined,
      "safe",
      undefined,
      proof,
    );
    expect(result.ok).toBe(ok);
    expect(staticWrite).toHaveBeenCalled();
  });

  it("rejects forged candidates before hashing or parsing", async () => {
    const update = vi.spyOn(ChunkedSha256.prototype, "update");
    await expect(
      parseRuntimeInput(
        svg,
        undefined,
        undefined,
        "safe",
        undefined,
        Object.create(SafeStaticProof.prototype) as SafeStaticProof,
      ),
    ).rejects.toThrow("owned validation");
    expect(update).not.toHaveBeenCalled();
  });

  it("cancels candidate binding before metadata adoption", async () => {
    const controller = new AbortController();
    const adopt = vi.fn();
    const staticWrite = vi.spyOn(StreamingSafeStaticValidator.prototype, "write");
    await expect(
      parseRuntimeInput(
        new TextEncoder().encode(svg),
        {
          signal: controller.signal,
          checkpoint: () => {
            controller.abort();
            return Promise.resolve();
          },
        },
        adopt,
        "safe",
        undefined,
        proof,
      ),
    ).rejects.toMatchObject({ code: "input-cancelled" });
    expect(adopt).not.toHaveBeenCalled();
    expect(staticWrite).not.toHaveBeenCalled();
  });
});

function previewInputBytes(kind: string): Uint8Array {
  const encoded = new TextEncoder().encode(svg);
  if (kind !== "shared" && kind !== "subarray") return encoded;
  const input =
    kind === "shared"
      ? new Uint8Array(new SharedArrayBuffer(encoded.byteLength))
      : new Uint8Array(encoded.byteLength + 1).subarray(1);
  input.set(encoded);
  return input;
}

it("keeps parsed private bytes intact when the caller changes already consumed input", async () => {
  const input = new TextEncoder().encode(svg);
  const controller = new AbortController();
  let changed = false;
  const copies = vi.spyOn(ChunkedInputHash.prototype, "copy");
  const staticWrite = vi.spyOn(StreamingSafeStaticValidator.prototype, "write");
  const result = await parseRuntimeInput(
    input,
    {
      signal: controller.signal,
      checkpoint: () => {
        const ownedBytes = copies.mock.results.reduce(
          (bytes, result) =>
            bytes + (result.type === "return" ? (result.value?.byteLength ?? 0) : 0),
          0,
        );
        if (!changed && ownedBytes === input.byteLength) {
          input[input.length - 1] = 0x20;
          changed = true;
        }
        return undefined;
      },
    },
    undefined,
    "safe",
    undefined,
    proof,
  );
  expect(changed).toBe(true);
  expect(input[input.length - 1]).toBe(0x20);
  expect(result).toMatchObject({
    ok: true,
    value: { hash: proof.outputHash, snapshot: expectedSnapshot },
  });
  expect(staticWrite).not.toHaveBeenCalled();
});
