import { describe, expect, it, vi } from "vitest";

import {
  adoptUtf8Output,
  adoptUtf8OutputWithPrefix,
  UTF8_OUTPUT_PREFIX_CODE_UNITS,
} from "../../../../src/persistence/scheduling/utf8-adoption";
import { utf8ByteLengthWithinLimit } from "../../../../src/persistence/scheduling/utf8-byte-length";

describe("UTF-8 output adoption", () => {
  it("counts actual UTF-8 bytes without trusting JavaScript code-unit length", () => {
    expect(utf8ByteLengthWithinLimit("a🙂€", 8)).toBe(8);
    expect(utf8ByteLengthWithinLimit("a🙂€", 7)).toBeNull();
    expect(utf8ByteLengthWithinLimit("\ud800", 3)).toBe(3);
  });

  it("decodes multibyte input split across chunks without loss", async () => {
    const expected = "a🙂ä漢字z";
    const checkpoint = vi.fn(() => Promise.resolve());

    await expect(
      adoptUtf8Output(new TextEncoder().encode(expected), { checkpoint, chunkBytes: 2 }),
    ).resolves.toBe(expected);
    expect(checkpoint).toHaveBeenCalled();
  });

  it("returns existing strings without scheduling adoption work", async () => {
    const checkpoint = vi.fn(() => Promise.resolve());

    await expect(adoptUtf8Output("ready", { checkpoint })).resolves.toBe("ready");
    await expect(adoptUtf8OutputWithPrefix("ready", { checkpoint })).resolves.toEqual({
      content: "ready",
      prefix: "ready",
    });
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("decodes all chunks before returning when checkpoints remain synchronous", async () => {
    const checkpoint = vi.fn(() => undefined);
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    const pending = adoptUtf8Output(new TextEncoder().encode("abcdefgh"), {
      checkpoint,
      chunkBytes: 2,
    });
    expect(decode).toHaveBeenCalledTimes(5);
    expect(checkpoint).toHaveBeenCalledTimes(6);
    await expect(pending).resolves.toBe("abcdefgh");
    decode.mockClear();
    checkpoint.mockClear();
    const prefixed = adoptUtf8OutputWithPrefix(new TextEncoder().encode("abcdefgh"), {
      checkpoint,
      chunkBytes: 2,
    });
    expect(decode).toHaveBeenCalledTimes(5);
    expect(checkpoint).toHaveBeenCalledTimes(6);
    await expect(prefixed).resolves.toEqual({ content: "abcdefgh", prefix: "abcdefgh" });
    decode.mockRestore();
  });

  it("rejects invalid chunk sizes", async () => {
    await expect(adoptUtf8Output(new Uint8Array(), { chunkBytes: 0 })).rejects.toThrow(
      "positive safe integer",
    );
  });

  it("rejects invalid UTF-8 and releases an aborted adoption", async () => {
    await expect(
      adoptUtf8Output(new Uint8Array([0x61, 0xf0, 0x9f, 0x99]), { chunkBytes: 2 }),
    ).rejects.toThrow();

    const controller = new AbortController();
    const checkpoint = vi.fn(async () => controller.abort());
    await expect(
      adoptUtf8Output(new TextEncoder().encode("pending"), {
        checkpoint,
        chunkBytes: 1,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
    expect(checkpoint).toHaveBeenCalledTimes(1);
  });
});

describe("UTF-8 output prefix adoption", () => {
  it("retains exact prefix code units when multibyte characters cross chunks and the prefix limit", async () => {
    const start = "a".repeat(UTF8_OUTPUT_PREFIX_CODE_UNITS - 1);
    const content = `${start}🙂ä漢字tail`;

    await expect(
      adoptUtf8OutputWithPrefix(new TextEncoder().encode(content), { chunkBytes: 2 }),
    ).resolves.toEqual({ content, prefix: `${start}\ud83d` });
  });

  it("still rejects invalid trailing UTF-8 and cancellation after the prefix is complete", async () => {
    const bytes = new TextEncoder().encode("a".repeat(UTF8_OUTPUT_PREFIX_CODE_UNITS + 1));
    bytes[bytes.length - 1] = 255;
    await expect(
      adoptUtf8OutputWithPrefix(bytes, { chunkBytes: UTF8_OUTPUT_PREFIX_CODE_UNITS }),
    ).rejects.toThrow();

    const controller = new AbortController();
    let checkpoints = 0;
    const checkpoint = (): undefined => {
      checkpoints += 1;
      if (checkpoints === 2) controller.abort();
      return undefined;
    };
    await expect(
      adoptUtf8OutputWithPrefix(new TextEncoder().encode("a".repeat(bytes.length)), {
        checkpoint,
        chunkBytes: UTF8_OUTPUT_PREFIX_CODE_UNITS,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
    expect(checkpoints).toBe(2);
  });
});
