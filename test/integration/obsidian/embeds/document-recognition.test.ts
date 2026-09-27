import { TFile, type Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import {
  hasCanonicalInkbookRootMarker,
  ObsidianInkbookDocumentRecognition,
} from "../../../../src/obsidian/embeds/document-recognition";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { createSnapshot } from "../../../unit/persistence/serialization/fixtures";

function testFile(path: string, size: number): TFile {
  const Constructor = TFile as unknown as new (filePath: string, fileSize: number) => TFile;
  return new Constructor(path, size);
}

function recognitionHarness(
  path: string,
  size: number,
  content: string,
  deferUntilLayoutReady = false,
) {
  const file = testFile(path, size);
  const cachedRead = vi.fn(async () => content);
  const recognition = new ObsidianInkbookDocumentRecognition(
    {
      cachedRead,
      getFileByPath: (candidate: string) => (candidate === file.path ? file : null),
    } as unknown as Vault,
    { deferUntilLayoutReady },
  );
  const changed = vi.fn();
  recognition.subscribe(changed);
  return { cachedRead, changed, file, recognition };
}

describe("Inkbook document recognition", () => {
  it("recognizes only a root-level Inkbook format marker", () => {
    expect(
      hasCanonicalInkbookRootMarker(
        '<svg xmlns="http://www.w3.org/2000/svg" data-inkbook-format="inkbook"></svg>',
      ),
    ).toBe(true);
    expect(
      hasCanonicalInkbookRootMarker('<svg><text>data-inkbook-format="inkbook"</text></svg>'),
    ).toBe(false);
    expect(hasCanonicalInkbookRootMarker('<svg data-inkbook-format="other"></svg>')).toBe(false);
  });

  it("leaves ordinary SVG files rejected and caches the bounded classification", async () => {
    const { cachedRead, changed, file, recognition } = recognitionHarness(
      "drawings/ordinary.svg",
      128,
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    );

    expect(recognition.cached(file.path)).toBeUndefined();
    await expect(recognition.recognize(file.path)).resolves.toBe(false);
    expect(recognition.cached(file.path)).toBe(false);
    await expect(recognition.recognize(file.path)).resolves.toBe(false);
    expect(cachedRead).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce();
  });

  it("rejects an Inkbook marker without the canonical preview viewBox", async () => {
    const { file, recognition } = recognitionHarness(
      "drawings/marker-only.svg",
      128,
      '<svg data-inkbook-format="inkbook"></svg>',
    );

    await expect(recognition.recognize(file.path)).resolves.toBe(false);
  });

  it("invalidates a recognized file without retaining stale classification", async () => {
    const serialized = serializeInkbookDocument(createSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const { changed, file, recognition } = recognitionHarness(
      "drawings/ink.svg",
      new TextEncoder().encode(serialized.value.svg).byteLength,
      serialized.value.svg,
    );

    await expect(recognition.recognize(file.path)).resolves.toMatchObject({
      aspectRatio: 2048.6 / serialized.value.lockedHeight,
      contentIdentity: {
        outputHash: serialized.value.hash,
        revision: serialized.value.snapshot.revision,
      },
      safeSvg: serialized.value.svg,
    });
    expect(recognition.cached(file.path)).toMatchObject({
      aspectRatio: 2048.6 / serialized.value.lockedHeight,
      contentIdentity: {
        outputHash: serialized.value.hash,
        revision: serialized.value.snapshot.revision,
      },
      safeSvg: serialized.value.svg,
    });
    recognition.invalidate(file.path);
    expect(recognition.cached(file.path)).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
  });
});

it("binds a versioned preview to its Vault resource despite changing host cache queries", async () => {
  const serialized = serializeInkbookDocument(createSnapshot());
  if (!serialized.ok) throw new Error("Invalid test snapshot");
  const file = testFile("drawings/ink book.svg", serialized.value.svg.length);
  let cacheToken = "1700000000000";
  const cachedRead = vi.fn(async () => serialized.value.svg);
  const vault = {
    cachedRead,
    getFileByPath: (path: string) => (path === file.path ? file : null),
    getResourcePath: () => `app://vault/drawings/ink%20book.svg?${cacheToken}`,
  } as unknown as Vault;
  const recognition = new ObsidianInkbookDocumentRecognition(vault);
  const sourceFor = (): string => {
    const url = new URL(vault.getResourcePath(file));
    url.searchParams.set(
      "inkbook-revision",
      `${String(serialized.value.snapshot.revision)}-${serialized.value.hash}`,
    );
    return url.href;
  };
  const first = await recognition.loadPreviewSource(file.path, sourceFor());
  expect(cachedRead).toHaveBeenCalledOnce();
  cacheToken = "1700000000001";
  expect(await recognition.loadPreviewSource(file.path, sourceFor())).toBe(first);
  expect(cachedRead).toHaveBeenCalledOnce();
  const otherPath = sourceFor().replace("ink%20book.svg", "other.svg");
  await expect(recognition.loadPreviewSource(file.path, otherPath)).rejects.toThrow(
    "does not match its file",
  );
  expect(cachedRead).toHaveBeenCalledOnce();
  recognition.dispose();
});

describe("layout-ready recognition gate", () => {
  it("deduplicates pending classification without reading until layout is ready", async () => {
    const serialized = serializeInkbookDocument(createSnapshot());
    if (!serialized.ok) throw new Error("Invalid fixture");
    const { cachedRead, changed, file, recognition } = recognitionHarness(
      "ink.svg",
      128,
      serialized.value.svg,
      true,
    );
    const pending = recognition.recognize(file.path);
    expect(recognition.recognize(file.path)).toBe(pending);
    await Promise.resolve();
    expect(cachedRead).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(recognition.cached(file.path)).toBeUndefined();
    recognition.markLayoutReady();
    recognition.markLayoutReady();
    await expect(pending).resolves.toMatchObject({ safeSvg: serialized.value.svg });
    expect(cachedRead).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce();
    recognition.dispose();
  });

  it("settles pending work on disposal without reading or notifying", async () => {
    const { cachedRead, changed, file, recognition } = recognitionHarness(
      "ink.svg",
      128,
      "<svg></svg>",
      true,
    );
    const pending = recognition.recognize(file.path);
    recognition.dispose();
    recognition.markLayoutReady();
    await expect(pending).resolves.toBe(false);
    await expect(recognition.recognize(file.path)).resolves.toBe(false);
    expect(cachedRead).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it("rejects a file changed while waiting without reading its obsolete signature", async () => {
    const { cachedRead, file, recognition } = recognitionHarness(
      "ink.svg",
      128,
      "<svg></svg>",
      true,
    );
    const pending = recognition.recognize(file.path);
    file.stat.mtime += 1;
    recognition.markLayoutReady();
    await expect(pending).resolves.toBe(false);
    expect(cachedRead).not.toHaveBeenCalled();
    expect(recognition.cached(file.path)).toBeUndefined();
    await expect(recognition.recognize(file.path)).resolves.toBe(false);
    expect(cachedRead).toHaveBeenCalledOnce();
    recognition.dispose();
  });

  it("fails closed when a released read fails and cancels release-before-disposal work", async () => {
    const { cachedRead, file, recognition } = recognitionHarness(
      "ink.svg",
      128,
      "<svg></svg>",
      true,
    );
    cachedRead.mockRejectedValueOnce(new Error("Read failed"));
    const pending = recognition.recognize(file.path);
    recognition.markLayoutReady();
    await expect(pending).resolves.toBe(false);
    expect(cachedRead).toHaveBeenCalledOnce();
    const cancelled = recognitionHarness("other.svg", 128, "<svg></svg>", true);
    const cancelledPending = cancelled.recognition.recognize(cancelled.file.path);
    cancelled.recognition.markLayoutReady();
    cancelled.recognition.dispose();
    await expect(cancelledPending).resolves.toBe(false);
    expect(cancelled.cachedRead).not.toHaveBeenCalled();
    recognition.dispose();
  });
});
