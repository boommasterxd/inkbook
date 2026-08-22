import { describe, expect, it, vi } from "vitest";
import {
  beginClipboardWriteDuringActivation,
  encodeSelection,
  INKBOOK_CLIPBOARD_WEB_MIME,
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
  it("constructs and starts a custom-format write before worker data resolves", async () => {
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

    expect(attempt.mode).toBe("custom-and-plain");
    expect(createItem).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect([...(createdItem?.formats.keys() ?? [])]).toEqual([
      INKBOOK_CLIPBOARD_WEB_MIME,
      "text/plain",
    ]);
    expect(retained).toEqual([]);

    resolvePayload!(encodedFixture());
    await expect(attempt.systemWrite).resolves.toBe(true);
    await attempt.payloadReady;
    expect(retained).toHaveLength(1);
  });

  it("falls back synchronously to plain text when custom item construction throws", async () => {
    const payload = encodedFixture();
    let construction = 0;
    const writes: FakeItem[] = [];
    const port: ClipboardWritePort<FakeItem> = {
      createItem: (formats) => {
        construction += 1;
        if (construction === 1) throw new Error("custom format rejected");
        return { formats };
      },
      write: async (items) => {
        writes.push(...items);
      },
      retainSessionPayload: () => undefined,
    };

    const attempt = beginClipboardWriteDuringActivation(port, Promise.resolve(payload));

    expect(attempt.mode).toBe("plain-only");
    expect(construction).toBe(2);
    expect(writes).toHaveLength(1);
    expect([...writes[0]!.formats.keys()]).toEqual(["text/plain"]);
    await expect(attempt.systemWrite).resolves.toBe(true);
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
});
