import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ChunkedInkbookInputParser } from "../../../../src/persistence/serialization/chunked-input-codec";
import { SafeStaticProof } from "../../../../src/persistence/serialization/safe-static-proof";
import { StreamingSafeStaticValidator } from "../../../../src/persistence/serialization/streaming-safe-static";
import { inspectTrustedSvgOutput } from "../../../../src/persistence/scheduling/trusted-svg-output";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import {
  encodeUnlockRequest,
  decodeUnlockRequest,
} from "../../../../src/persistence/worker/runtime/unlock-request-wire";
import { rewriteDocumentMetadata } from "../../../fixtures/persistence/metadata-rewrite";
import { createSnapshot } from "./fixtures";
import { parseRuntimeInput } from "../../../../src/persistence/worker/runtime/parse-runtime-input";
import { ChunkedSha256 } from "../../../../src/persistence/serialization/chunked-output-sha256";

let svg: string;
let proof: SafeStaticProof;

beforeAll(async () => {
  const serialized = serializeInkbookDocument(createSnapshot());
  if (!serialized.ok) throw new Error(serialized.error.code);
  svg = serialized.value.svg;
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
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(adopt).not.toHaveBeenCalled();
    expect(staticWrite).not.toHaveBeenCalled();
  });

  it("retains terminal byte binding when input changes after the candidate hash", async () => {
    const input = new TextEncoder().encode(svg);
    const controller = new AbortController();
    let remainingHashCheckpoints = Math.ceil(input.byteLength / (64 * 1024));
    const staticWrite = vi.spyOn(StreamingSafeStaticValidator.prototype, "write");
    const result = await parseRuntimeInput(
      input,
      {
        signal: controller.signal,
        checkpoint: () => {
          remainingHashCheckpoints -= 1;
          if (remainingHashCheckpoints === 0) input[input.length - 1] = 0x20;
          return undefined;
        },
      },
      undefined,
      "safe",
      undefined,
      proof,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "invalid-svg" } });
    expect(staticWrite).not.toHaveBeenCalled();
  });
});
