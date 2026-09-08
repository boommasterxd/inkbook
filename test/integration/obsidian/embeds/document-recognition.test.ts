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

function recognitionHarness(path: string, size: number, content: string) {
  const file = testFile(path, size);
  const cachedRead = vi.fn(async () => content);
  const recognition = new ObsidianInkbookDocumentRecognition({
    cachedRead,
    getFileByPath: (candidate: string) => (candidate === file.path ? file : null),
  } as unknown as Vault);
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
