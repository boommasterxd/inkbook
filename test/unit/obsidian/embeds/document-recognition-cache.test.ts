import { TFile, type Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ObsidianInkbookDocumentRecognition } from "../../../../src/obsidian/embeds/document-recognition";
import { inspectPreviewSvg } from "../../../../src/obsidian/embeds/safe-preview-svg";

vi.mock("../../../../src/obsidian/embeds/safe-preview-svg", () => ({ inspectPreviewSvg: vi.fn() }));

function cacheHarness(sliceBudgetMs?: () => number) {
  const File = TFile as unknown as new (path: string, size: number) => TFile;
  const files = new Map(["a.svg", "b.svg", "c.svg"].map((path) => [path, new File(path, 100)]));
  const recognition = new ObsidianInkbookDocumentRecognition(
    {
      getFileByPath: (path: string) => files.get(path) ?? null,
      cachedRead: async () => '<svg data-inkbook-format="inkbook" viewBox="0 0 2048.6 100"></svg>',
    } as unknown as Vault,
    sliceBudgetMs === undefined ? {} : { sliceBudgetMs },
  );
  return recognition;
}

function previewWithSize(size: number) {
  return {
    aspectRatio: 1,
    safeSvg: "x".repeat(size),
    contentIdentity: { revision: 0, outputHash: "hash" },
  };
}

describe("completed recognition markup budgets", () => {
  it("evicts at completion rather than waiting for another read and preserves recent hits", async () => {
    const recognition = cacheHarness();
    vi.mocked(inspectPreviewSvg).mockResolvedValue(previewWithSize(12 * 1024 * 1024));
    await recognition.recognize("a.svg");
    await recognition.recognize("b.svg");
    expect(recognition.cached("a.svg")).not.toBeUndefined();
    await recognition.recognize("c.svg");
    expect(recognition.cached("b.svg")).toBeUndefined();
    expect(recognition.cached("a.svg")).not.toBeUndefined();
    expect(recognition.cached("c.svg")).not.toBeUndefined();
    recognition.dispose();
  });

  it("retains one individually larger document and releases its accounting on invalidation", async () => {
    const recognition = cacheHarness();
    vi.mocked(inspectPreviewSvg).mockResolvedValue(previewWithSize(33 * 1024 * 1024));
    await recognition.recognize("a.svg");
    expect(recognition.cached("a.svg")).not.toBeUndefined();
    recognition.invalidate("a.svg");
    vi.mocked(inspectPreviewSvg).mockResolvedValue(previewWithSize(1));
    await recognition.recognize("b.svg");
    await recognition.recognize("c.svg");
    expect(recognition.cached("b.svg")).not.toBeUndefined();
    expect(recognition.cached("c.svg")).not.toBeUndefined();
    recognition.dispose();
  });
});

it("passes the live workspace budget into recognition validation", async () => {
  let budget = 4;
  const readBudget = () => budget;
  const recognition = cacheHarness(readBudget);
  vi.mocked(inspectPreviewSvg).mockResolvedValue(previewWithSize(1));
  await recognition.recognize("a.svg");
  const forwarded = vi.mocked(inspectPreviewSvg).mock.lastCall?.[3];
  expect(forwarded).toBe(readBudget);
  expect(forwarded?.()).toBe(4);
  budget = 2;
  expect(forwarded?.()).toBe(2);
  recognition.dispose();
});
