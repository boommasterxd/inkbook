import { describe, expect, it } from "vitest";

import {
  assembleAndHashChunkedOutput,
  assembleAndHashChunkedUtf8Output,
  ChunkedOutputCancelledError,
  ChunkedOutputLimitError,
  hashExactUtf8Output,
} from "../../../../src/persistence/serialization/chunked-output-assembler";
import { sha256Hex } from "../../../../src/persistence/serialization/sha256";

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

describe("chunked output assembly", () => {
  it("assembles byte-identical output and hash from reusable fragments", async () => {
    const fragments = ["<svg>", "<metadata>Ink &amp; book</metadata>", "</svg>"];
    const expected = fragments.join("");

    await expect(assembleAndHashChunkedOutput(fragments)).resolves.toEqual({
      hash: sha256Hex(expected),
      output: expected,
      totalBytes: new TextEncoder().encode(expected).byteLength,
    });
  });

  it("preserves UTF-8 hashing when a surrogate pair crosses fragment and slice boundaries", async () => {
    const fragments = ["before \ud83d", "\udd8b after ä"];
    const expected = fragments.join("");
    const result = await assembleAndHashChunkedOutput(fragments, { sliceByteLimit: 3 });

    expect(result.output).toBe(expected);
    expect(result.hash).toBe(sha256Hex(expected));
    expect(result.totalBytes).toBe(new TextEncoder().encode(expected).byteLength);
  });

  it("writes exact transferable UTF-8 bytes without constructing a complete output string", async () => {
    const fragments = ["before \ud83d", "\udd8b after ä"];
    const expected = new TextEncoder().encode(fragments.join(""));
    const result = await assembleAndHashChunkedUtf8Output(fragments, expected.byteLength, {
      checkpoint: async () => undefined,
      sliceByteLimit: 3,
    });

    expect(result.output).toEqual(expected);
    expect(result.output.byteOffset).toBe(0);
    expect(result.output.byteLength).toBe(result.output.buffer.byteLength);
    expect(result.hash).toBe(sha256Hex(expected));
  });

  it("rejects an inconsistent exact UTF-8 allocation", async () => {
    await expect(assembleAndHashChunkedUtf8Output(["abcd"], 3)).rejects.toBeInstanceOf(
      ChunkedOutputLimitError,
    );
    await expect(assembleAndHashChunkedUtf8Output(["abcd"], 5)).rejects.toThrow(
      "byte count is inconsistent",
    );
    const multibyte = "ä✒️";
    const exactBytes = new TextEncoder().encode(multibyte).byteLength;
    await expect(
      assembleAndHashChunkedUtf8Output([multibyte], exactBytes - 1),
    ).rejects.toBeInstanceOf(ChunkedOutputLimitError);
    await expect(assembleAndHashChunkedUtf8Output([multibyte], exactBytes + 1)).rejects.toThrow(
      "byte count is inconsistent",
    );
  });

  it("checks cancellation before consuming fragments", async () => {
    const controller = new AbortController();
    controller.abort();
    let consumed = false;
    const fragments = {
      *[Symbol.iterator](): Iterator<string> {
        consumed = true;
        yield "unreachable";
      },
    };

    await expect(
      assembleAndHashChunkedOutput(fragments, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(ChunkedOutputCancelledError);
    expect(consumed).toBe(false);
  });

  it("rejects before retaining an output that exceeds the encoded byte budget", async () => {
    let consumed = 0;
    const fragments = {
      *[Symbol.iterator](): Iterator<string> {
        consumed += 1;
        yield "ab";
        consumed += 1;
        yield "cd";
      },
    };

    await expect(
      assembleAndHashChunkedOutput(fragments, { maximumBytes: 3 }),
    ).rejects.toBeInstanceOf(ChunkedOutputLimitError);
    expect(consumed).toBe(2);
  });
});

describe("exact UTF-8 encoding parity", () => {
  it.each([
    { fragments: ["plain ASCII"], name: "ASCII" },
    { fragments: ["Grüße ", "東京"], name: "multibyte text" },
    {
      fragments: [`before ${String.fromCharCode(0xd83d)}`, `${String.fromCharCode(0xdd8b)} after`],
      name: "split surrogate pair",
    },
    { fragments: [`lone ${String.fromCharCode(0xd83d)}`], name: "lone surrogate" },
  ])("matches canonical TextEncoder bytes for $name", async ({ fragments }) => {
    const expected = new TextEncoder().encode(fragments.join(""));
    const result = await assembleAndHashChunkedUtf8Output(fragments, expected.byteLength, {
      sliceByteLimit: 5,
    });

    expect(result.output).toEqual(expected);
    expect(result.hash).toBe(sha256Hex(expected));
  });
});

describe("chunked output checkpoints", () => {
  it("invokes the injected checkpoint after bounded slices", async () => {
    let checkpoints = 0;
    const output = "abcdefghijklmno";
    const result = await assembleAndHashChunkedOutput([output], {
      checkpoint: async () => {
        checkpoints += 1;
      },
      sliceByteLimit: 5,
    });

    expect(result.output).toBe(output);
    expect(checkpoints).toBe(3);
  });

  it("cancels deterministically after an input-aware checkpoint", async () => {
    await expectCancellationAfterCheckpoint((checkpoint, signal) =>
      assembleAndHashChunkedOutput(["a".repeat(20)], {
        checkpoint,
        signal,
        sliceByteLimit: 4,
      }),
    );
  });

  it("rejects invalid slice limits before consuming fragments", async () => {
    await expect(assembleAndHashChunkedOutput(["content"], { sliceByteLimit: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});

describe("exact UTF-8 output hashing", () => {
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

  it("assembles concurrent outputs without sharing encoder state", async () => {
    const high = String.fromCharCode(0xd83d);
    const inputs = [
      [`left ${high}`, String.fromCharCode(0xdd8b)],
      [`right ${high}`, String.fromCharCode(0xde80)],
    ];
    const expected = inputs.map((fragments) => new TextEncoder().encode(fragments.join("")));
    const results = await Promise.all(
      inputs.map((fragments, index) =>
        assembleAndHashChunkedUtf8Output(fragments, expected[index]!.byteLength),
      ),
    );

    expect(results.map(({ output }) => output)).toEqual(expected);
    expect(results.map(({ hash }) => hash)).toEqual(expected.map(sha256Hex));
  });

  it("honors slice cancellation while writing directly into exact output", async () => {
    await expectCancellationAfterCheckpoint((checkpoint, signal) =>
      assembleAndHashChunkedUtf8Output(["a".repeat(20)], 20, {
        checkpoint,
        signal,
        sliceByteLimit: 4,
      }),
    );
  });
});
