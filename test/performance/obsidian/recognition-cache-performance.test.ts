import { TFile, type Vault } from "obsidian";
import { ObsidianInkbookDocumentRecognition } from "../../../src/obsidian/embeds/document-recognition";
import { serializeSvgEnvelope } from "../../../src/persistence/documents/svg-envelope";
import * as safeSvgValidator from "../../../src/persistence/documents/safe-svg-validator";
import { ChunkedSha256 } from "../../../src/persistence/serialization/chunked-output-sha256";
import { hashConfirmedSvgContent } from "../../../src/persistence/scheduling/trusted-svg-output";
import { createSnapshot } from "../../unit/persistence/serialization/fixtures";
import { deferredPreviewRecognition } from "../../fixtures/obsidian/deferred-preview-recognition";
import { immediateWorkScheduler } from "../../fixtures/obsidian/immediate-work-scheduler";
import { expect, it, vi } from "vitest";

function recognitionCacheFixture(
  recognitionConstructor: typeof ObsidianInkbookDocumentRecognition,
  fileCount: number,
) {
  const File = TFile as unknown as new (path: string, size: number) => TFile;
  const files = Array.from(
    { length: fileCount },
    (_, index) => new File(`${String(index)}.svg`, 10),
  );
  const byPath = new Map(files.map((file) => [file.path, file]));
  let reads = 0;
  const recognition = new recognitionConstructor(
    {
      getFileByPath: (path: string) => byPath.get(path) ?? null,
      cachedRead: async () => {
        reads += 1;
        return "invalid";
      },
    } as unknown as Vault,
    { workScheduler: immediateWorkScheduler() },
  );
  return { files, recognition, reads: () => reads };
}

it("admits and completes recognition with bounded cache eviction with bounded work", async () => {
  const { files, recognition, reads } = recognitionCacheFixture(
    ObsidianInkbookDocumentRecognition,
    900,
  );

  for (let index = 0; index < files.length; index += 1) {
    await recognition.recognize(files[index]!.path);
  }
  expect(files.filter((file) => recognition.cached(file.path) !== undefined)).toHaveLength(256);
  expect(reads()).toBe(files.length);
  await recognition.recognize(files[files.length - 1]!.path);
  expect(reads()).toBe(files.length);
  expect(recognition.cached(files[0]!.path)).toBeUndefined();
  await recognition.recognize(files[0]!.path);
  expect(reads()).toBe(files.length + 1);
  recognition.dispose();
});

it("shares one full Vault read, hash, and safe inspection across visible preview consumers", async () => {
  const svg = serializeSvgEnvelope(createSnapshot(), 148.6, {
    background: [],
    highlights: [],
    content: ['<path d="M0 0L1 1" fill="none" stroke="#112233FF"/>'.repeat(10_000)],
  });
  const outputHash = await hashConfirmedSvgContent(svg);
  const { file, cachedRead, recognition, release } = deferredPreviewRecognition(
    "shared.svg",
    svg.length,
  );
  const hash = vi.spyOn(ChunkedSha256.prototype, "update");
  const inspect = vi.spyOn(safeSvgValidator, "validateSafeSvgSteps");
  const expectedHashBytes = new TextEncoder().encode(svg).byteLength;
  const assertSingleInspection = (): void => {
    expect(hash.mock.calls.reduce((bytes, [part]) => bytes + part.byteLength, 0)).toBe(
      expectedHashBytes,
    );
    expect(inspect).toHaveBeenCalledOnce();
  };
  const source = `app://shared.svg?inkbook-revision=${String(createSnapshot().revision)}-${outputHash}`;
  const first = recognition.loadPreviewSource(file.path, source);
  const second = recognition.loadPreviewSource(file.path, source);
  expect(cachedRead).toHaveBeenCalledOnce();
  release(svg);
  const [firstValue, secondValue] = await Promise.all([first, second]);
  expect(firstValue).toBe(secondValue);
  assertSingleInspection();
  expect(await recognition.loadPreviewSource(file.path, source)).toBe(firstValue);
  expect(cachedRead).toHaveBeenCalledOnce();
  assertSingleInspection();
  recognition.dispose();
  vi.restoreAllMocks();
});
