import { describe, expect, it, vi } from "vitest";
import {
  beginClipboardWriteDuringActivation,
  type ClipboardWritePort,
  type ClipboardWritePayload,
} from "../../../../src/persistence/clipboard/public";
import { encodeRuntimeSelection } from "../../../../src/persistence/clipboard/codec";
import { type EncodedClipboard } from "../../../../src/persistence/clipboard/types";
import { RECTANGLE_ID, rectangle } from "../../../unit/persistence/clipboard/fixtures";

declare function setImmediate(callback: () => void): void;

interface FakeItem {
  formats: ReadonlyMap<string, Promise<string>>;
}

type WriteFailure = "item-construction" | "async-write" | "sync-write";

function failedClipboardPort(failure: WriteFailure) {
  const retained: ClipboardWritePayload[] = [];
  const write = vi.fn(() => {
    if (failure === "sync-write") throw new DOMException("permission denied", "NotAllowedError");
    return Promise.reject(new Error("permission denied"));
  });
  const port: ClipboardWritePort<FakeItem> = {
    createItem: (formats) => {
      if (failure === "item-construction") throw new Error("ClipboardItem unavailable");
      return { formats };
    },
    write,
    retainSessionPayload: (payload) => retained.push(payload),
  };
  return { port, retained, write };
}

const encodedFixture = (): EncodedClipboard => {
  const encoded = encodeRuntimeSelection([rectangle()], new Set([RECTANGLE_ID]));
  if (!encoded.ok) throw new Error(encoded.error.message);
  return encoded.value;
};

describe("clipboard write adapter plan", () => {
  it("starts one plain-text system write before worker data resolves", async () => {
    let resolvePayload: ((payload: EncodedClipboard) => void) | undefined;
    const pendingPayload = new Promise<EncodedClipboard>((resolve) => {
      resolvePayload = resolve;
    });
    const retained: ClipboardWritePayload[] = [];
    let createdItem: FakeItem | undefined;
    const createItem = vi.fn((formats: ReadonlyMap<string, Promise<string>>): FakeItem => {
      createdItem = { formats };
      return createdItem;
    });
    const write = vi.fn(async () => undefined);
    const port: ClipboardWritePort<FakeItem> = {
      createItem,
      write,
      retainSessionPayload: (payload) => retained.push(payload),
    };

    const attempt = beginClipboardWriteDuringActivation(port, pendingPayload);

    expect(attempt.mode).toBe("plain-only");
    expect(createItem).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect([...(createdItem?.formats.keys() ?? [])]).toEqual(["text/plain"]);
    expect(retained).toEqual([]);

    const payload = encodedFixture();
    resolvePayload!(payload);
    await expect(attempt.systemWrite).resolves.toBe(true);
    await attempt.payloadReady;
    expect(retained).toHaveLength(1);
    await expect(createdItem?.formats.get("text/plain")).resolves.toBe(payload.plainText);
  });

  it.each(["item-construction", "async-write", "sync-write"] as const)(
    "retains the session payload without retrying after %s failure",
    async (failure) => {
      const payload = encodedFixture();
      const { port, retained, write } = failedClipboardPort(failure);

      const attempt = beginClipboardWriteDuringActivation(port, Promise.resolve(payload));

      expect(attempt.mode).toBe(failure === "item-construction" ? "unavailable" : "plain-only");
      await expect(attempt.systemWrite).resolves.toBe(false);
      await attempt.payloadReady;
      expect(write).toHaveBeenCalledTimes(failure === "item-construction" ? 0 : 1);
      expect(retained).toEqual([payload]);
    },
  );

  it.each(["item-construction", "async-write", "sync-write"] as const)(
    "contains an encoding rejection when %s does not consume clipboard data",
    async (failure) => {
      const error = new Error("Clipboard encoding failed.");
      const { port, retained, write } = failedClipboardPort(failure);
      const attempt = beginClipboardWriteDuringActivation(port, Promise.reject(error));

      await expect(attempt.payloadReady).rejects.toBe(error);
      await expect(attempt.systemWrite).resolves.toBe(false);
      expect(retained).toEqual([]);
      expect(write).toHaveBeenCalledTimes(failure === "item-construction" ? 0 : 1);
      // Let the host report unhandled rejections before Vitest completes this case.
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  );
});
