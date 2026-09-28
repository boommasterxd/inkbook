import { afterEach, expect, it, vi } from "vitest";
import {
  probeClipboardCandidate,
  MAX_CLIPBOARD_ITEMS,
} from "../../../src/obsidian/embeds/active-editor/clipboard-reader";
import {
  CLIPBOARD_LIMITS,
  INKBOOK_CLIPBOARD_TEXT_PREFIX,
  INKBOOK_CLIPBOARD_WEB_MIME,
} from "../../../src/persistence/clipboard/constants";
import { createLargeClipboardCandidate } from "../../fixtures/persistence/clipboard-candidate";

afterEach(() => vi.restoreAllMocks());

function clipboard(blob: Blob, mime: string, count = 1): Clipboard {
  const item = { types: [mime], getType: async () => blob } as unknown as ClipboardItem;
  return { read: async () => Array.from({ length: count }, () => item) } as unknown as Clipboard;
}

it.each([INKBOOK_CLIPBOARD_WEB_MIME, "text/plain"])(
  "bounds %s candidate reads independently of a 10,000-element payload",
  async (mime) => {
    const payload = createLargeClipboardCandidate();
    const prefix = mime === "text/plain" ? INKBOOK_CLIPBOARD_TEXT_PREFIX : "";
    const blob = new Blob([prefix, payload]);
    expect(blob.size).toBeLessThan(CLIPBOARD_LIMITS.totalInputBytes);
    const fullRead = vi.spyOn(blob, "text");
    const slice = vi.spyOn(blob, "slice");
    const port = clipboard(blob, mime);
    expect(await probeClipboardCandidate(port)).toBe(true);
    expect(await probeClipboardCandidate(port)).toBe(true);
    expect(fullRead).not.toHaveBeenCalled();
    expect(slice.mock.calls).toEqual(
      mime === "text/plain"
        ? [
            [0, INKBOOK_CLIPBOARD_TEXT_PREFIX.length],
            [0, INKBOOK_CLIPBOARD_TEXT_PREFIX.length],
          ]
        : [],
    );
  },
);

it("rejects byte and item capacity before reading or slicing candidate bodies", async () => {
  const blob = new Blob([" ".repeat(CLIPBOARD_LIMITS.totalInputBytes + 1)]);
  const read = vi.spyOn(blob, "text");
  const slice = vi.spyOn(blob, "slice");
  expect(await probeClipboardCandidate(clipboard(blob, "text/plain"))).toBe(false);
  expect(
    await probeClipboardCandidate(
      clipboard(blob, INKBOOK_CLIPBOARD_WEB_MIME, MAX_CLIPBOARD_ITEMS + 1),
    ),
  ).toBe(false);
  expect(read).not.toHaveBeenCalled();
  expect(slice).not.toHaveBeenCalled();
});

it.each(["", "ordinary text", INKBOOK_CLIPBOARD_TEXT_PREFIX])(
  "rejects noncandidate text %j",
  async (text) => {
    expect(await probeClipboardCandidate(clipboard(new Blob([text]), "text/plain"))).toBe(false);
  },
);
