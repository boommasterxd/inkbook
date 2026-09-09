import { TFile, type Vault } from "obsidian";
import { describe, expect, it } from "vitest";
import { ObsidianInkbookDocumentRecognition } from "../../../../src/obsidian/embeds/document-recognition";

function boundedHarness(count: number, deferred = false) {
  const File = TFile as unknown as new (path: string, size: number) => TFile;
  const files = Array.from({ length: count }, (_, index) => new File(`${String(index)}.svg`, 10));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const reads: Array<() => void> = [];
  let active = 0;
  let maximum = 0;
  let failResolution = false;
  const recognition = new ObsidianInkbookDocumentRecognition(
    {
      getFileByPath: (path: string) => {
        if (failResolution) throw new Error("Vault lookup failed");
        return byPath.get(path) ?? null;
      },
      cachedRead: () => {
        active += 1;
        maximum = Math.max(maximum, active);
        return new Promise<string>((resolve) =>
          reads.push(() => {
            active -= 1;
            resolve("invalid");
          }),
        );
      },
    } as unknown as Vault,
    { deferUntilLayoutReady: deferred },
  );
  return {
    recognition,
    failResolution: (value: boolean) => {
      failResolution = value;
    },
    files,
    reads,
    get maximum() {
      return maximum;
    },
    async drain() {
      while (reads.length > 0) {
        reads.shift()?.();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
}

describe("recognition resource limits", () => {
  it("bounds concurrent reads and completed cache entries across a completion burst", async () => {
    const h = boundedHarness(257);
    const pending = h.files.map((file) => h.recognition.recognize(file.path));
    expect(h.reads).toHaveLength(4);
    await h.drain();
    expect((await Promise.all(pending)).every((value) => value === false)).toBe(true);
    expect(h.maximum).toBe(4);
    expect(h.files.filter((file) => h.recognition.cached(file.path) !== undefined)).toHaveLength(
      256,
    );
    expect(h.recognition.cached(h.files[0]!.path)).toBeUndefined();
    h.recognition.dispose();
  });

  it("bounds the waiting queue and permits retry after uncached overload", async () => {
    const h = boundedHarness(4097, true);
    const pending = h.files.slice(0, 4096).map((file) => h.recognition.recognize(file.path));
    const overflow = h.files[4096]!.path;
    await expect(h.recognition.recognize(overflow)).resolves.toBe(false);
    expect(h.recognition.cached(overflow)).toBeUndefined();
    expect(h.reads).toHaveLength(0);
    h.recognition.invalidate(h.files[0]!.path);
    await expect(pending[0]).resolves.toBe(false);
    const retry = h.recognition.recognize(overflow);
    expect(h.recognition.recognize(overflow)).toBe(retry);
    h.recognition.dispose();
    expect((await Promise.all([...pending, retry])).every((value) => value === false)).toBe(true);
    expect(h.reads).toHaveLength(0);
  });

  it("settles running and queued work on disposal without publishing late results", async () => {
    const h = boundedHarness(5);
    let notifications = 0;
    h.recognition.subscribe(() => {
      notifications += 1;
    });
    const pending = h.files.map((file) => h.recognition.recognize(file.path));
    h.recognition.dispose();
    expect((await Promise.all(pending)).every((value) => value === false)).toBe(true);
    await h.drain();
    expect(h.maximum).toBe(4);
    expect(notifications).toBe(0);
  });

  it("invalidates a running request without allowing it to replace its successor", async () => {
    const h = boundedHarness(1);
    const path = h.files[0]!.path;
    const stale = h.recognition.recognize(path);
    h.recognition.invalidate(path);
    await expect(stale).resolves.toBe(false);
    const current = h.recognition.recognize(path);
    expect(current).not.toBe(stale);
    h.reads.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.recognition.cached(path)).toBeUndefined();
    await h.drain();
    await expect(current).resolves.toBe(false);
    expect(h.recognition.cached(path)).toBe(false);
    h.recognition.dispose();
  });
});

describe("recognition failure isolation", () => {
  it("continues queued reads and independent subscribers after a listener throws", async () => {
    const h = boundedHarness(5);
    let completed = 0;
    h.recognition.subscribe(() => {
      throw new Error("Presentation failed");
    });
    h.recognition.subscribe(() => {
      completed += 1;
    });
    const pending = h.files.map((file) => h.recognition.recognize(file.path));
    await h.drain();
    await Promise.all(pending);
    expect(completed).toBe(5);
    expect(h.maximum).toBe(4);
    h.recognition.dispose();
  });

  it("releases rejected read slots and continues the queue after an initial vault lookup throws", async () => {
    const h = boundedHarness(5, true);
    const pending = h.files.map((file) => h.recognition.recognize(file.path));
    h.failResolution(true);
    h.recognition.markLayoutReady();
    expect((await Promise.all(pending)).every((value) => value === false)).toBe(true);
    expect(h.reads).toHaveLength(0);
    h.failResolution(false);
    h.recognition.invalidate(h.files[0]!.path);
    const retry = h.recognition.recognize(h.files[0]!.path);
    await h.drain();
    await expect(retry).resolves.toBe(false);
    expect(h.maximum).toBe(1);
    h.recognition.dispose();
  });
});
