import { describe, expect, it, vi } from "vitest";
import {
  beginClipboardWriteDuringActivation,
  encodeSelection,
  type ClipboardWritePort,
  type ClipboardWritePayload,
  type EncodedClipboard,
} from "../../../../src/persistence/clipboard/public";
import { RECTANGLE_ID, rectangle } from "../../../unit/persistence/clipboard/fixtures";

interface FakeItem {
  formats: ReadonlyMap<string, Promise<string>>;
}

const encodedFixture = (): EncodedClipboard => {
  const encoded = encodeSelection([rectangle()], new Set([RECTANGLE_ID]));
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

  it("retains the session payload when plain item construction is unavailable", async () => {
    const payload = encodedFixture();
    const retained: ClipboardWritePayload[] = [];
    const write = vi.fn(async () => undefined);
    const port: ClipboardWritePort<FakeItem> = {
      createItem: () => {
        throw new Error("ClipboardItem unavailable");
      },
      write,
      retainSessionPayload: (value) => retained.push(value),
    };

    const attempt = beginClipboardWriteDuringActivation(port, Promise.resolve(payload));

    expect(attempt.mode).toBe("unavailable");
    await expect(attempt.systemWrite).resolves.toBe(false);
    await attempt.payloadReady;
    expect(write).not.toHaveBeenCalled();
    expect(retained).toEqual([payload]);
  });

  it("retains the session payload and does not retry after an asynchronous write rejection", async () => {
    const payload = encodedFixture();
    const retained: ClipboardWritePayload[] = [];
    let writes = 0;
    const port: ClipboardWritePort<FakeItem> = {
      createItem: (formats) => ({ formats }),
      write: () => {
        writes += 1;
        return Promise.reject(new Error("permission denied"));
      },
      retainSessionPayload: (value) => retained.push(value),
    };

    const attempt = beginClipboardWriteDuringActivation(port, Promise.resolve(payload));

    await expect(attempt.systemWrite).resolves.toBe(false);
    await attempt.payloadReady;
    expect(writes).toBe(1);
    expect(retained).toEqual([payload]);
  });

  it("normalizes a synchronous system write exception to a failed attempt", async () => {
    const payload = encodedFixture();
    const retainSessionPayload = vi.fn();
    const port: ClipboardWritePort<FakeItem> = {
      createItem: (formats) => ({ formats }),
      write: () => {
        throw new DOMException("permission denied", "NotAllowedError");
      },
      retainSessionPayload,
    };

    const attempt = beginClipboardWriteDuringActivation(port, Promise.resolve(payload));

    await expect(attempt.systemWrite).resolves.toBe(false);
    await attempt.payloadReady;
    expect(retainSessionPayload).toHaveBeenCalledWith(payload);
  });
});
