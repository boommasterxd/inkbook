import { TFile, type Vault } from "obsidian";
import { ObsidianInkbookDocumentRecognition } from "../../../src/obsidian/embeds/document-recognition";
import { expect, it } from "vitest";
import { expectTiming } from "../timing-assertions";
import { interactionP99, INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";

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
  const recognition = new recognitionConstructor({
    getFileByPath: (path: string) => byPath.get(path) ?? null,
    cachedRead: async () => "invalid",
  } as unknown as Vault);
  return { files, recognition };
}

it("admits and completes recognition with bounded cache eviction within the frame budget", async ({
  annotate,
}) => {
  const { files, recognition } = recognitionCacheFixture(
    ObsidianInkbookDocumentRecognition,
    INTERACTION_REFRESH_PROFILE.sampleCount + 300,
  );
  const durations: number[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const started = performance.now();
    await recognition.recognize(files[index]!.path);
    if (index >= 300) durations.push(performance.now() - started);
  }
  expect(files.filter((file) => recognition.cached(file.path) !== undefined)).toHaveLength(256);
  recognition.dispose();
  const p99 = interactionP99(durations);
  expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
  await annotate(
    `Recognition admission and cache eviction p99=${p99.toFixed(3)} ms`,
    "performance",
  );
});
