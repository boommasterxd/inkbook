import { expect, it, vi } from "vitest";

import { ElementStore } from "../../../../../src/domain/store/public";
import { CLIPBOARD_LIMITS } from "../../../../../src/persistence/clipboard/constants";
import { copyTextSelection } from "../../../../../src/obsidian/embeds/active-editor/clipboard-text-copy";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { observeSelectionStoreMethod } from "../../../../fixtures/obsidian/selection-store-work";
import { singleLineTextElement, textElement } from "../../../../fixtures/rendering/text";

it("copies 5,000 text sources in a 10,000-stroke document through selected indexed reads only", async () => {
  const elements = Array.from({ length: CLIPBOARD_LIMITS.elements }, (_, index) => ({
    ...singleLineTextElement(`$x_{${index}}$`),
    id: `00000000-0000-4001-8000-${index.toString().padStart(12, "0")}`,
  }));
  const store = new ElementStore([
    ...Array.from({ length: 10_000 }, (_, index) => indexedStroke(index)),
    ...elements,
  ]);
  const read = observeSelectionStoreMethod(store, "get");
  const rank = observeSelectionStoreMethod(store, "getRank");
  const band = observeSelectionStoreMethod(store, "materializeBandOrder");
  const checkpoint = vi.fn(() => undefined);
  const write = vi.fn(async () => undefined);
  const createItem = vi.fn((formats: ReadonlyMap<string, Promise<string>>) => formats);
  const beforeScans = store.instrumentation.fullStoreScans;
  try {
    const result = await copyTextSelection({
      store,
      selection: new Set([...elements].reverse().map(({ id }) => id)),
      scheduler: { ...immediateWorkScheduler(), checkpoint },
      signal: new AbortController().signal,
      timers: { setTimeout: () => 0, clearTimeout: vi.fn() },
      isCurrent: () => true,
      isSelectionCurrent: () => true,
      port: { createItem, write },
    });
    expect(result).toEqual({
      kind: "copied",
      source: elements.map(({ source }) => source).join("\n\n"),
    });
    expect(read.work.calls).toBe(CLIPBOARD_LIMITS.elements);
    expect(rank.work.calls).toBe(CLIPBOARD_LIMITS.elements);
    expect(band.work.calls).toBe(0);
    expect(store.instrumentation.fullStoreScans).toBe(beforeScans);
    expect(checkpoint.mock.calls.length).toBeGreaterThan(CLIPBOARD_LIMITS.elements);
    expect(checkpoint.mock.calls.length).toBeLessThanOrEqual(CLIPBOARD_LIMITS.elements * 14);
    expect(createItem).toHaveBeenCalledOnce();
    expect([...createItem.mock.calls[0]![0].keys()]).toEqual(["text/plain"]);
    expect(write).toHaveBeenCalledOnce();
  } finally {
    read.restore();
    rank.restore();
    band.restore();
  }
});

it("starts the native write before yielding and cancels selected work through the central scheduler", async () => {
  const elements = Array.from({ length: CLIPBOARD_LIMITS.elements }, (_, index) =>
    textElement({ id: `00000000-0000-4001-8000-${index.toString().padStart(12, "0")}` }),
  );
  const store = new ElementStore(elements);
  const read = observeSelectionStoreMethod(store, "get");
  let release: (() => void) | undefined;
  let current = true;
  const checkpoint = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const write = vi.fn(async () => undefined);
  try {
    const result = copyTextSelection({
      store,
      selection: new Set(elements.map(({ id }) => id)),
      scheduler: { ...immediateWorkScheduler(), checkpoint },
      signal: new AbortController().signal,
      timers: { setTimeout: () => 0, clearTimeout: vi.fn() },
      isCurrent: () => current,
      isSelectionCurrent: () => true,
      port: { createItem: (formats) => formats, write },
    });
    expect(write).toHaveBeenCalledOnce();
    expect(read.work.calls).toBe(1);
    expect(checkpoint).toHaveBeenCalledOnce();
    current = false;
    release?.();
    await expect(result).resolves.toEqual({ kind: "unavailable", reason: "stale-operation" });
    expect(read.work.calls).toBeLessThanOrEqual(2);
  } finally {
    release?.();
    read.restore();
  }
});
