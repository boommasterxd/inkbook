import { TFile, type Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ObsidianInkbookDocumentRecognition } from "../../../../src/obsidian/embeds/document-recognition";
import { inspectPreviewSvg } from "../../../../src/obsidian/embeds/safe-preview-svg";
import { createConfirmedOutputFixture } from "../../../fixtures/obsidian/confirmed-output";

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

it("grants canonical proof only to a current own write confirmation", async () => {
  const { file, serialized, signature } = createConfirmedOutputFixture();
  const File = TFile as unknown as new (path: string, size: number) => TFile;
  const files = new Map([[file.path, file]]);
  const recognition = new ObsidianInkbookDocumentRecognition({
    getFileByPath: (path: string) => files.get(path) ?? null,
    cachedRead: async () => serialized.value.svg,
  } as unknown as Vault);
  const read = {
    content: serialized.value.svg,
    identity: {
      ctime: file.stat.ctime,
      mtime: file.stat.mtime,
      path: file.path,
      size: file.stat.size,
    },
    materialization: "host-full-read-not-bounded" as const,
    stabilityEvidence: "object-identity-and-stat-unchanged" as const,
  };
  vi.mocked(inspectPreviewSvg).mockResolvedValueOnce({
    aspectRatio: 1,
    contentIdentity: { outputHash: serialized.value.hash, revision: 0 },
    safeSvg: serialized.value.svg,
  });
  await recognition.recognize(file.path);
  expect(recognition.matchesConfirmedOutput(read)).toBe(false);

  recognition.acceptConfirmedOutput(
    file.path,
    serialized.value.svg,
    serialized.value.hash,
    signature,
  );
  expect(recognition.matchesConfirmedOutput(read)).toBe(true);
  expect(recognition.matchesConfirmedOutput({ ...read, content: `${read.content} ` })).toBe(false);
  expect(
    recognition.matchesConfirmedOutput({
      ...read,
      identity: { ...read.identity, mtime: read.identity.mtime + 1 },
    }),
  ).toBe(false);
  recognition.deferRefresh(file.path);
  expect(recognition.matchesConfirmedOutput(read)).toBe(false);
  recognition.acceptConfirmedOutput(
    file.path,
    serialized.value.svg,
    serialized.value.hash,
    signature,
  );
  files.set(file.path, new File(file.path, file.stat.size));
  expect(recognition.matchesConfirmedOutput(read)).toBe(false);
  recognition.invalidate(file.path);
  recognition.dispose();
  expect(recognition.matchesConfirmedOutput(read)).toBe(false);
});

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

it("aborts an obsolete running inspection before its replacement is published", async () => {
  const recognition = cacheHarness();
  let signal: AbortSignal | undefined;
  vi.mocked(inspectPreviewSvg).mockImplementationOnce((_source, _wait, abort) => {
    signal = abort;
    return new Promise((resolve) => abort?.addEventListener("abort", () => resolve(null)));
  });
  const pending = recognition.recognize("a.svg");
  await Promise.resolve();
  expect(signal?.aborted).toBe(false);
  recognition.invalidate("a.svg");
  expect(signal?.aborted).toBe(true);
  await expect(pending).resolves.toBe(false);
  vi.mocked(inspectPreviewSvg).mockResolvedValueOnce(previewWithSize(1));
  expect(await recognition.recognize("a.svg")).not.toBe(false);
  recognition.dispose();
});

it("settles deferred first recognition and permits external revalidation", async () => {
  const recognition = cacheHarness();
  const changed = vi.fn();
  recognition.subscribe(changed);
  vi.mocked(inspectPreviewSvg).mockImplementationOnce(
    (_source, _wait, signal) =>
      new Promise((resolve) => signal?.addEventListener("abort", () => resolve(null))),
  );
  const obsolete = recognition.recognize("a.svg");
  await Promise.resolve();
  recognition.deferRefresh("a.svg");
  await expect(obsolete).resolves.toBe(false);
  recognition.invalidate("a.svg");
  expect(changed).toHaveBeenCalledOnce();
  vi.mocked(inspectPreviewSvg).mockResolvedValueOnce(previewWithSize(1));
  expect(await recognition.recognize("a.svg")).not.toBe(false);
  recognition.dispose();
});
