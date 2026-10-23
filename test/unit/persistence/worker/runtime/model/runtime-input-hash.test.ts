import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_SCHEMA_LIMITS } from "../../../../../../src/domain/schema/public";
import { ChunkedSha256 } from "../../../../../../src/persistence/serialization/chunked-output-sha256";
import { sha256Hex } from "../../../../../../src/persistence/serialization/sha256";
import {
  hashConfirmedRuntimeInput,
  hashRuntimeInput,
} from "../../../../../../src/persistence/worker/runtime/model/runtime-input-hash";
import type { RuntimeSliceContext } from "../../../../../../src/persistence/worker/runtime/types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function sliceContext(inputByteLimit = 64 * 1024): RuntimeSliceContext {
  return {
    checkpoint: vi.fn(() => undefined),
    signal: new AbortController().signal,
    workProfile: { inputByteLimit, nodeLimit: 1, outputByteLimit: 1 },
  };
}

function observeEncoding() {
  const encoder = new TextEncoder();
  const encodeInto = encoder.encodeInto.bind(encoder);
  let bytes = 0;
  let codeUnits = 0;
  const encode = vi
    .spyOn(TextEncoder.prototype, "encodeInto")
    .mockImplementation((input, destination) => {
      const result = encodeInto(input, destination);
      bytes += result.written;
      codeUnits += result.read;
      return result;
    });
  return { encode, writtenBytes: () => bytes, readCodeUnits: () => codeUnits };
}

async function referenceHash(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("confirmed worker native hash evidence", () => {
  it("encodes complete Unicode once under the shared checkpoint and digests exact bytes", async () => {
    const input = "a😀ä".repeat(20);
    const expected = sha256Hex(input);
    const bytes = new TextEncoder().encode(input).byteLength;
    const encoding = observeEncoding();
    const hash = vi.spyOn(ChunkedSha256.prototype, "update");
    const digest = vi.spyOn(crypto.subtle, "digest");
    const context = sliceContext(3);
    await expect(hashConfirmedRuntimeInput(input, context, bytes)).resolves.toBe(expected);
    expect(encoding.writtenBytes()).toBe(bytes);
    expect(encoding.readCodeUnits()).toBe(input.length);
    expect(encoding.encode.mock.calls.every(([fragment]) => fragment.length <= 3)).toBe(true);
    expect(vi.mocked(context.checkpoint).mock.calls.length).toBeGreaterThanOrEqual(
      Math.ceil(input.length / 3),
    );
    expect(vi.mocked(context.checkpoint).mock.calls.length).toBeLessThanOrEqual(
      1 + encoding.encode.mock.calls.length,
    );
    expect(digest).toHaveBeenCalledExactlyOnceWith("SHA-256", expect.any(Uint8Array));
    expect(digest.mock.calls[0]![1].byteLength).toBe(bytes);
    expect(hash).not.toHaveBeenCalled();
  });

  it.each([-1, Number.NaN, FILE_SCHEMA_LIMITS.totalInputBytes + 1, 5, 7])(
    "rejects a false or invalid expected size %s before native hashing",
    async (expectedBytes) => {
      const digest = vi.spyOn(crypto.subtle, "digest");
      await expect(
        hashConfirmedRuntimeInput("ä😀", sliceContext(), expectedBytes),
      ).resolves.toBeNull();
      expect(digest).not.toHaveBeenCalled();
    },
  );

  it.each([0, Number.NaN, 1.5, -1])("normalizes invalid input profile %s", async (profile) => {
    await expect(hashConfirmedRuntimeInput("ä😀", sliceContext(profile), 6)).resolves.toBe(
      sha256Hex("ä😀"),
    );
  });

  it("keeps sliced unlock hashing and byte-input handling independent of native preflight", async () => {
    const input = "ä😀";
    const bytes = new TextEncoder().encode(input);
    const expected = sha256Hex(bytes);
    const digest = vi.spyOn(crypto.subtle, "digest");
    await expect(hashRuntimeInput(input, sliceContext(), bytes.byteLength)).resolves.toBe(expected);
    await expect(hashConfirmedRuntimeInput(bytes, sliceContext(), bytes.byteLength)).resolves.toBe(
      expected,
    );
    expect(digest).not.toHaveBeenCalled();
  });
});

describe("confirmed worker native hash fallback", () => {
  it("accepts exactly 20 MiB in the native digest without retaining a sliced hash", async () => {
    const input = "x".repeat(20 * 1024 * 1024);
    const expected = await referenceHash(input);
    const digest = vi.spyOn(crypto.subtle, "digest");
    const hash = vi.spyOn(ChunkedSha256.prototype, "update");
    await expect(hashConfirmedRuntimeInput(input, sliceContext(), input.length)).resolves.toBe(
      expected,
    );
    expect(digest).toHaveBeenCalledTimes(1);
    expect(digest.mock.calls[0]![1].byteLength).toBe(input.length);
    expect(hash).not.toHaveBeenCalled();
  });
  it.each(["missing-crypto", "missing-subtle"])("streams exact bytes with %s", async (mode) => {
    const input = "ä😀".repeat(20);
    const expected = sha256Hex(input);
    const hash = vi.spyOn(ChunkedSha256.prototype, "update");
    const encode = vi.spyOn(TextEncoder.prototype, "encodeInto");
    vi.stubGlobal("crypto", mode === "missing-crypto" ? undefined : { subtle: undefined });
    await expect(hashConfirmedRuntimeInput(input, sliceContext(3), 120)).resolves.toBe(expected);
    expect(hash.mock.calls.reduce((bytes, [chunk]) => bytes + chunk.byteLength, 0)).toBe(120);
    expect(hash.mock.calls.every(([chunk]) => chunk.byteLength <= 9)).toBe(true);
    expect(encode).not.toHaveBeenCalled();
  });

  it.each(["rejected", "malformed"])(
    "reuses encoded bytes after a %s native digest",
    async (mode) => {
      const input = "ä😀".repeat(20_000);
      const expected = sha256Hex(input);
      const digest = vi.spyOn(crypto.subtle, "digest");
      if (mode === "rejected") digest.mockRejectedValue(new Error("Unavailable native digest"));
      else digest.mockResolvedValue(new ArrayBuffer(31));
      const encoding = observeEncoding();
      const hash = vi.spyOn(ChunkedSha256.prototype, "update");
      await expect(hashConfirmedRuntimeInput(input, sliceContext(), 120_000)).resolves.toBe(
        expected,
      );
      expect(digest).toHaveBeenCalledTimes(1);
      expect(encoding.writtenBytes()).toBe(120_000);
      expect(hash.mock.calls.reduce((bytes, [chunk]) => bytes + chunk.byteLength, 0)).toBe(120_000);
      expect(hash.mock.calls.every(([chunk]) => chunk.byteLength <= 64 * 1024)).toBe(true);
    },
  );

  it.each(["x", "ä"])("streams above the 20 MiB native byte cap with %s", async (character) => {
    const input = character.repeat((20 * 1024 * 1024) / (character === "x" ? 1 : 2) + 1);
    const expected = await referenceHash(input);
    const bytes = new TextEncoder().encode(input).byteLength;
    const digest = vi.spyOn(crypto.subtle, "digest");
    const encode = vi.spyOn(TextEncoder.prototype, "encodeInto");
    const hash = vi.spyOn(ChunkedSha256.prototype, "update");
    await expect(hashConfirmedRuntimeInput(input, sliceContext(), bytes)).resolves.toBe(expected);
    expect(digest).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
    expect(hash.mock.calls.reduce((sum, [chunk]) => sum + chunk.byteLength, 0)).toBe(bytes);
    expect(hash.mock.calls.every(([chunk]) => chunk.byteLength <= 3 * 64 * 1024)).toBe(true);
  });
});

describe("confirmed worker native hash cancellation", () => {
  it("aborts at an encoding checkpoint before native dispatch", async () => {
    const controller = new AbortController();
    let checkpoints = 0;
    const digest = vi.spyOn(crypto.subtle, "digest");
    const context = {
      signal: controller.signal,
      checkpoint: () => {
        checkpoints += 1;
        if (checkpoints === 3) controller.abort();
        return undefined;
      },
    };
    await expect(hashConfirmedRuntimeInput("x".repeat(3 * 64 * 1024), context)).rejects.toThrow();
    expect(checkpoints).toBe(3);
    expect(digest).not.toHaveBeenCalled();
  });

  it("rejects a native result completed after cancellation without hashing it again", async () => {
    const controller = new AbortController();
    let complete!: (digest: ArrayBuffer) => void;
    let dispatched!: () => void;
    const ready = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation(() => {
      dispatched();
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    const hash = vi.spyOn(ChunkedSha256.prototype, "update");
    const pending = hashConfirmedRuntimeInput(
      "ä😀",
      { signal: controller.signal, checkpoint: () => undefined },
      6,
    );
    await ready;
    expect(digest).toHaveBeenCalledTimes(1);
    controller.abort();
    complete(new ArrayBuffer(32));
    await expect(pending).rejects.toThrow();
    expect(hash).not.toHaveBeenCalled();
  });
});
