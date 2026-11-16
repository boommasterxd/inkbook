import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeBinaryResource } from "../../../../src/persistence/serialization/binary-resource";
import { sha256Hex } from "../../../../src/persistence/serialization/sha256";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";

afterEach(() => vi.restoreAllMocks());

function expectedResource(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 4096)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
  return {
    id: sha256Hex(bytes),
    data: btoa(binary),
  };
}

function sourceBytes(length: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length }, (_, index) => index % 256);
}

describe("binary resource encoding", () => {
  it.each([49_151, 49_152, 49_153])(
    "preserves canonical Base64 and SHA-256 for a %i-byte view across native chunk padding",
    async (length) => {
      const bytes = sourceBytes(length + 1).subarray(1);
      const scheduler = new TestWorkScheduler({ checkpoint: async () => undefined });
      await expect(encodeBinaryResource(bytes, scheduler)).resolves.toEqual(
        expectedResource(bytes),
      );
    },
  );

  it("retains the complete portable encoder when native Base64 is unavailable", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "toBase64")!;
    Object.defineProperty(Uint8Array.prototype, "toBase64", {
      configurable: true,
      value: undefined,
    });
    try {
      const bytes = sourceBytes(8193);
      const scheduler = new TestWorkScheduler({ checkpoint: async () => undefined });
      await expect(encodeBinaryResource(bytes, scheduler)).resolves.toEqual(
        expectedResource(bytes),
      );
    } finally {
      Object.defineProperty(Uint8Array.prototype, "toBase64", descriptor);
    }
  });

  it("binds both outputs to private bytes when the caller changes its input during a checkpoint", async () => {
    const bytes = sourceBytes(100_001);
    const expected = expectedResource(bytes);
    let checkpoints = 0;
    const scheduler = new TestWorkScheduler({
      checkpoint: () => {
        if (++checkpoints === 2) bytes.fill(0);
        return Promise.resolve();
      },
    });
    await expect(encodeBinaryResource(bytes, scheduler)).resolves.toEqual(expected);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it("falls back to exact sliced SHA-256 when the native digest rejects", async () => {
    vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("Digest unavailable"));
    const bytes = sourceBytes(100_001);
    await expect(encodeBinaryResource(bytes, new TestWorkScheduler())).resolves.toEqual(
      expectedResource(bytes),
    );
  });

  it("rejects a late native digest after the owner cancels", async () => {
    let finish!: (digest: ArrayBuffer) => void;
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const controller = new AbortController();
    const encoded = encodeBinaryResource(
      sourceBytes(10),
      new TestWorkScheduler(),
      controller.signal,
    );
    await vi.waitFor(() => expect(digest).toHaveBeenCalledOnce());
    controller.abort();
    finish(new ArrayBuffer(32));
    await expect(encoded).rejects.toThrow("cancelled");
  });
});
