import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assembleAndHashPreparedUtf8Output,
  ChunkedOutputCancelledError,
  ChunkedOutputLimitError,
  hashExactUtf8Output,
} from "../../../../src/persistence/serialization/chunked-output-assembler";
import { sha256Hex } from "../../../../src/persistence/serialization/sha256";

afterEach(() => vi.restoreAllMocks());

async function expectCancellationAfterCheckpoint(
  operation: (checkpoint: () => Promise<void>, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  const controller = new AbortController();
  let checkpoints = 0;

  await expect(
    operation(async () => {
      checkpoints += 1;
      controller.abort();
    }, controller.signal),
  ).rejects.toBeInstanceOf(ChunkedOutputCancelledError);
  expect(checkpoints).toBe(1);
}

describe("prepared UTF-8 output assembly", () => {
  it("checks cancellation before consuming prepared fragments", async () => {
    const controller = new AbortController();
    controller.abort();
    const fragments = { [Symbol.iterator]: vi.fn(() => [new Uint8Array(4)][Symbol.iterator]()) };

    await expect(
      assembleAndHashPreparedUtf8Output(fragments, 4, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(ChunkedOutputCancelledError);
    expect(fragments[Symbol.iterator]).not.toHaveBeenCalled();
  });

  it.each(["plain ASCII", "Grüße 東京", "before 🖋 after", "lone \ud83d"])(
    "preserves exact prepared UTF-8 bytes across fragment and copy boundaries for %j",
    async (text) => {
      const bytes = new TextEncoder().encode(text);
      const result = await assembleAndHashPreparedUtf8Output(
        [bytes.subarray(0, 8), bytes.subarray(8)],
        bytes.byteLength,
        { checkpoint: () => undefined, sliceByteLimit: 3 },
      );

      expect(result.output).toEqual(bytes);
      expect(result.hash).toBe(sha256Hex(bytes));
      expect(result.totalBytes).toBe(bytes.byteLength);
    },
  );

  it("copies exact prepared Unicode bytes without encoding or mutating the fragments", async () => {
    const text = "Grüße 東京 😀<&>";
    const bytes = new TextEncoder().encode(text);
    const fragments = [bytes.subarray(0, 5), bytes.subarray(5)];
    const expectedHash = sha256Hex(bytes);
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    const encodeInto = vi.spyOn(TextEncoder.prototype, "encodeInto");

    const result = await assembleAndHashPreparedUtf8Output(fragments, bytes.byteLength, {
      sliceByteLimit: 3,
    });

    expect(result.output).toEqual(bytes);
    expect(result.output.buffer).not.toBe(bytes.buffer);
    expect(result.output.byteOffset).toBe(0);
    expect(result.output.byteLength).toBe(result.output.buffer.byteLength);
    expect(result.hash).toBe(expectedHash);
    expect(result.totalBytes).toBe(bytes.byteLength);
    expect(encode).not.toHaveBeenCalled();
    expect(encodeInto).not.toHaveBeenCalled();
  });

  it("rejects incorrect allocations and byte limits before consuming excessive data", async () => {
    const fragment = new Uint8Array([1, 2, 3, 4]);
    await expect(assembleAndHashPreparedUtf8Output([fragment], 3)).rejects.toBeInstanceOf(
      ChunkedOutputLimitError,
    );
    await expect(assembleAndHashPreparedUtf8Output([fragment], 5)).rejects.toThrow(
      "byte count is inconsistent",
    );
    const fragments = { [Symbol.iterator]: vi.fn(() => [fragment][Symbol.iterator]()) };
    await expect(
      assembleAndHashPreparedUtf8Output(fragments, 4, { maximumBytes: 3 }),
    ).rejects.toBeInstanceOf(ChunkedOutputLimitError);
    expect(fragments[Symbol.iterator]).not.toHaveBeenCalled();
    await expect(
      assembleAndHashPreparedUtf8Output([], 0, { sliceByteLimit: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("cancels between bounded copies and leaves reusable source buffers intact", async () => {
    const bytes = new Uint8Array(20).fill(7);
    const expected = bytes.slice();
    await expectCancellationAfterCheckpoint((checkpoint, signal) =>
      assembleAndHashPreparedUtf8Output([bytes], bytes.byteLength, {
        checkpoint,
        signal,
        sliceByteLimit: 4,
      }),
    );
    expect(bytes).toEqual(expected);
    await expect(
      assembleAndHashPreparedUtf8Output([bytes], bytes.byteLength),
    ).resolves.toMatchObject({
      output: expected,
      totalBytes: bytes.byteLength,
    });
  });
});

describe("prepared output checkpoints", () => {
  it("invokes the injected checkpoint after bounded byte copies", async () => {
    let checkpoints = 0;
    const output = new TextEncoder().encode("abcdefghijklmno");
    const result = await assembleAndHashPreparedUtf8Output([output], output.byteLength, {
      checkpoint: async () => {
        checkpoints += 1;
      },
      sliceByteLimit: 5,
    });

    expect(result.output).toEqual(output);
    expect(checkpoints).toBe(3);
  });
});

describe("exact UTF-8 output hashing", () => {
  it("checkpoints final hashing after platform digest rejection", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("offline"));
    const text = "a".repeat(70 * 1024);
    let checkpoints = 0;
    const expected = new TextEncoder().encode(text);

    const result = await assembleAndHashPreparedUtf8Output([expected], expected.byteLength, {
      checkpoint: async () => {
        checkpoints += 1;
      },
      sliceByteLimit: 128 * 1024,
    });

    expect(digest).toHaveBeenCalledOnce();
    expect(result.hash).toBe(sha256Hex(expected));
    expect(checkpoints).toBe(2);
  });

  it.each([
    ["unavailable", null],
    ["rejected", async () => Promise.reject(new Error("Digest unavailable."))],
  ] as const)(
    "falls back to the streaming reference when WebCrypto is %s",
    async (_name, digest) => {
      const output = new TextEncoder().encode("fallback ✒️");

      await expect(hashExactUtf8Output(output, undefined, digest)).resolves.toBe(sha256Hex(output));
    },
  );

  it("rejects cancellation immediately before and after the platform digest", async () => {
    const output = new TextEncoder().encode("cancelled");
    const before = new AbortController();
    before.abort();
    let invoked = false;
    await expect(
      hashExactUtf8Output(output, before.signal, async () => {
        invoked = true;
        return new ArrayBuffer(32);
      }),
    ).rejects.toBeInstanceOf(ChunkedOutputCancelledError);
    expect(invoked).toBe(false);

    const after = new AbortController();
    await expect(
      hashExactUtf8Output(output, after.signal, async () => {
        after.abort();
        return new ArrayBuffer(32);
      }),
    ).rejects.toBeInstanceOf(ChunkedOutputCancelledError);
  });

  it("keeps concurrent exact-output digest results isolated", async () => {
    const outputs = ["left", "right", "repeat", "repeat"].map((value) =>
      new TextEncoder().encode(value),
    );

    await expect(
      Promise.all(outputs.map((output) => hashExactUtf8Output(output))),
    ).resolves.toEqual(outputs.map(sha256Hex));
  });

  it("copies concurrent prepared outputs into independent exact buffers", async () => {
    const expected = ["left 🖋", "right 🚀"].map((text) => new TextEncoder().encode(text));
    const results = await Promise.all(
      expected.map((bytes) =>
        assembleAndHashPreparedUtf8Output(
          [bytes.subarray(0, 6), bytes.subarray(6)],
          bytes.byteLength,
        ),
      ),
    );

    expect(results.map(({ output }) => output)).toEqual(expected);
    expect(results.map(({ hash }) => hash)).toEqual(expected.map(sha256Hex));
    expect(results[0]!.output.buffer).not.toBe(expected[0]!.buffer);
    expect(results[1]!.output.buffer).not.toBe(expected[1]!.buffer);
  });
});
