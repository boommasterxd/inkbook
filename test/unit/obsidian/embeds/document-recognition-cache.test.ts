import { TFile, type Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ObsidianInkbookDocumentRecognition } from "../../../../src/obsidian/embeds/document-recognition";
import { createRecognitionWorkScheduler } from "../../../../src/obsidian/embeds/document-recognition-scheduler";
import { inspectPreviewSvg } from "../../../../src/obsidian/embeds/safe-preview-svg";
import { createConfirmedOutputFixture } from "../../../fixtures/obsidian/confirmed-output";
import { immediateWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";
import type { WorkScheduler } from "../../../../src/domain/scheduling/work-scheduler";
import { SchedulerDisposedError } from "../../../../src/domain/scheduling/work-scheduler";

vi.mock("../../../../src/obsidian/embeds/safe-preview-svg", () => ({ inspectPreviewSvg: vi.fn() }));

function cacheHarness(
  workScheduler?: WorkScheduler | ((ownerWindow: Window | null) => WorkScheduler),
  deferUntilLayoutReady = false,
) {
  const File = TFile as unknown as new (path: string, size: number) => TFile;
  const files = new Map(["a.svg", "b.svg", "c.svg"].map((path) => [path, new File(path, 100)]));
  const recognition = new ObsidianInkbookDocumentRecognition(
    {
      getFileByPath: (path: string) => files.get(path) ?? null,
      cachedRead: async () => '<svg data-inkbook-format="inkbook" viewBox="0 0 2048.6 100"></svg>',
    } as unknown as Vault,
    { deferUntilLayoutReady, workScheduler: workScheduler ?? immediateWorkScheduler() },
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

function inspectAfterCheckpoint(): void {
  vi.mocked(inspectPreviewSvg).mockImplementationOnce(async (_source, options) => {
    await options.workScheduler.checkpoint();
    return previewWithSize(1);
  });
}

function blockedScheduler(onAbort: () => void): WorkScheduler {
  const scheduler = immediateWorkScheduler();
  scheduler.checkpoint = (signal) =>
    new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        onAbort();
        reject(new Error("transferred"));
      });
    });
  return scheduler;
}

it("grants canonical proof only to a current own write confirmation", async () => {
  const { file, serialized, signature } = createConfirmedOutputFixture();
  const File = TFile as unknown as new (path: string, size: number) => TFile;
  const files = new Map([[file.path, file]]);
  const recognition = new ObsidianInkbookDocumentRecognition(
    {
      getFileByPath: (path: string) => files.get(path) ?? null,
      cachedRead: async () => serialized.value.svg,
    } as unknown as Vault,
    { workScheduler: immediateWorkScheduler() },
  );
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

it("passes the shared workspace scheduler into recognition validation", async () => {
  const scheduler = immediateWorkScheduler();
  const checkpoint = vi.spyOn(scheduler, "checkpoint");
  const recognition = cacheHarness(scheduler);
  vi.mocked(inspectPreviewSvg).mockImplementation(async (_source, options) => {
    await options.workScheduler.checkpoint();
    return previewWithSize(1);
  });
  await recognition.recognize("a.svg");
  expect(checkpoint).toHaveBeenCalledOnce();
  recognition.dispose();
});

it("keeps signaled in-budget checkpoints synchronous but waits for an explicit frame", async () => {
  const scheduler = immediateWorkScheduler();
  const checkpoint = vi.spyOn(scheduler, "checkpoint");
  const nextFrame = vi.spyOn(scheduler, "nextFrame");
  const transfer = new AbortController();
  const cancellation = new AbortController();
  const caller = new AbortController();
  const NativeAbortController = AbortController;
  const constructed = vi.fn();
  class CountingAbortController extends NativeAbortController {
    constructor() {
      super();
      constructed();
    }
  }
  const routed = createRecognitionWorkScheduler(
    () => scheduler,
    () => transfer.signal,
    cancellation.signal,
  );
  vi.stubGlobal("AbortController", CountingAbortController);
  try {
    expect(routed.checkpoint(caller.signal)).toBeUndefined();
    expect(constructed).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
    await routed.nextFrame(caller.signal);
    expect(constructed).toHaveBeenCalledOnce();
    expect(nextFrame).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
    routed.dispose();
  }
});

function ownerWindow(visibilityState: DocumentVisibilityState): Window {
  const document = Object.assign(new EventTarget(), { visibilityState });
  return Object.assign(new EventTarget(), { closed: false, document }) as Window;
}

it("shares validation across a hidden main window and a visible pop-out", async () => {
  const main = ownerWindow("hidden");
  const popout = ownerWindow("visible");
  const mainScheduler = immediateWorkScheduler();
  const popoutScheduler = immediateWorkScheduler();
  const mainCheckpoint = vi.spyOn(mainScheduler, "checkpoint");
  const popoutCheckpoint = vi.spyOn(popoutScheduler, "checkpoint");
  const schedulerFor = vi.fn((owner: Window | null) =>
    owner === popout ? popoutScheduler : mainScheduler,
  );
  const recognition = cacheHarness(schedulerFor);
  vi.mocked(inspectPreviewSvg).mockImplementationOnce(async (_source, options) => {
    await options.workScheduler.checkpoint();
    return previewWithSize(1);
  });

  const first = recognition.recognize("a.svg", main);
  const second = recognition.recognize("a.svg", popout);
  expect(second).toBe(first);
  await expect(first).resolves.toMatchObject({ safeSvg: "x" });
  expect(inspectPreviewSvg).toHaveBeenCalledOnce();
  expect(schedulerFor).toHaveBeenCalledWith(popout);
  expect(popoutCheckpoint).toHaveBeenCalledOnce();
  expect(mainCheckpoint).not.toHaveBeenCalled();
  recognition.dispose();
});

it("moves an in-flight checkpoint to a visible requester", async () => {
  const main = ownerWindow("hidden");
  const popout = ownerWindow("visible");
  const popoutScheduler = immediateWorkScheduler();
  const mainCancelled = vi.fn();
  const mainScheduler = blockedScheduler(mainCancelled);
  const popoutCheckpoint = vi.spyOn(popoutScheduler, "checkpoint");
  const recognition = cacheHarness((owner) => (owner === popout ? popoutScheduler : mainScheduler));
  inspectAfterCheckpoint();

  const first = recognition.recognize("a.svg", main);
  await vi.waitFor(() => expect(inspectPreviewSvg).toHaveBeenCalledOnce());
  expect(recognition.recognize("a.svg", popout)).toBe(first);
  await expect(first).resolves.toMatchObject({ safeSvg: "x" });
  expect(mainCancelled).toHaveBeenCalledOnce();
  expect(popoutCheckpoint).toHaveBeenCalledOnce();
  recognition.invalidate("a.svg");
  recognition.dispose();
});

it("moves an in-flight checkpoint when registered windows change visibility", async () => {
  const main = ownerWindow("visible");
  const popout = ownerWindow("hidden");
  const popoutScheduler = immediateWorkScheduler();
  const mainCancelled = vi.fn();
  const mainScheduler = blockedScheduler(mainCancelled);
  const popoutCheckpoint = vi.spyOn(popoutScheduler, "checkpoint");
  const releaseMain = vi.spyOn(main.document, "removeEventListener");
  const releasePopout = vi.spyOn(popout.document, "removeEventListener");
  const recognition = cacheHarness((owner) => (owner === popout ? popoutScheduler : mainScheduler));
  inspectAfterCheckpoint();

  const pending = recognition.recognize("a.svg", main);
  expect(recognition.recognize("a.svg", popout)).toBe(pending);
  await vi.waitFor(() => expect(inspectPreviewSvg).toHaveBeenCalledOnce());
  expect(popoutCheckpoint).not.toHaveBeenCalled();
  Object.assign(main.document, { visibilityState: "hidden" });
  Object.assign(popout.document, { visibilityState: "visible" });
  popout.document.dispatchEvent(new Event("visibilitychange"));
  await expect(pending).resolves.toMatchObject({ safeSvg: "x" });
  expect(mainCancelled).toHaveBeenCalledOnce();
  expect(popoutCheckpoint).toHaveBeenCalledOnce();
  expect(inspectPreviewSvg).toHaveBeenCalledOnce();
  expect(releaseMain).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  expect(releasePopout).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  recognition.dispose();
});

it.each(["invalidate", "dispose"] as const)(
  "releases queued owner listeners on %s",
  async (action) => {
    const owner = ownerWindow("visible");
    const releaseDocument = vi.spyOn(owner.document, "removeEventListener");
    const releaseWindow = vi.spyOn(owner, "removeEventListener");
    const recognition = cacheHarness(undefined, true);
    const pending = recognition.recognize("a.svg", owner);
    if (action === "invalidate") recognition.invalidate("a.svg");
    else recognition.dispose();
    await expect(pending).resolves.toBe(false);
    expect(releaseDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(releaseWindow).toHaveBeenCalledWith("unload", expect.any(Function));
    recognition.dispose();
  },
);

function closedWindowFallbackHarness() {
  const popout = ownerWindow("visible");
  const fallback = immediateWorkScheduler();
  const fallbackCheckpoint = vi.spyOn(fallback, "checkpoint");
  const popoutScheduler = immediateWorkScheduler();
  const recognition = cacheHarness((owner) => (owner === popout ? popoutScheduler : fallback));
  inspectAfterCheckpoint();
  return { fallbackCheckpoint, popout, popoutScheduler, recognition };
}

it("continues a shared inspection after its pop-out window closes", async () => {
  const { fallbackCheckpoint, popout, popoutScheduler, recognition } =
    closedWindowFallbackHarness();
  const cancelled = vi.fn();
  popoutScheduler.checkpoint = (signal) =>
    new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        cancelled();
        reject(new Error("window closed"));
      });
    });
  const pending = recognition.recognize("a.svg", popout);
  await vi.waitFor(() => expect(inspectPreviewSvg).toHaveBeenCalledOnce());
  Object.assign(popout, { closed: true });
  popout.dispatchEvent(new Event("unload"));
  await expect(pending).resolves.toMatchObject({ safeSvg: "x" });
  expect(cancelled).toHaveBeenCalledOnce();
  expect(fallbackCheckpoint).toHaveBeenCalledOnce();
  expect(inspectPreviewSvg).toHaveBeenCalledOnce();
  recognition.dispose();
});

it("falls back after an abrupt window close without an unload event", async () => {
  const { fallbackCheckpoint, popout, popoutScheduler, recognition } =
    closedWindowFallbackHarness();
  let fail!: (error: Error) => void;
  popoutScheduler.checkpoint = () =>
    new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
  const pending = recognition.recognize("a.svg", popout);
  await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
  Object.assign(popout, { closed: true });
  fail(new SchedulerDisposedError());
  await expect(pending).resolves.toMatchObject({ safeSvg: "x" });
  expect(fallbackCheckpoint).toHaveBeenCalledOnce();
  expect(inspectPreviewSvg).toHaveBeenCalledOnce();
  recognition.dispose();
});

it("falls back when a requester closes or detaches before validation", async () => {
  const popout = ownerWindow("visible");
  const fallback = immediateWorkScheduler();
  const fallbackCheckpoint = vi.spyOn(fallback, "checkpoint");
  const schedulerFor = vi.fn((_owner: Window | null) => fallback);
  const recognition = cacheHarness(schedulerFor);
  vi.mocked(inspectPreviewSvg).mockImplementation(async (_source, options) => {
    await options.workScheduler.checkpoint();
    return previewWithSize(1);
  });
  const first = recognition.recognize("a.svg", popout);
  Object.assign(popout, { closed: true });
  popout.dispatchEvent(new Event("unload"));
  await first;
  expect(schedulerFor).toHaveBeenCalledWith(null);
  await recognition.recognize("b.svg", null);
  expect(fallbackCheckpoint).toHaveBeenCalledTimes(2);
  recognition.dispose();
});

it("aborts an obsolete running inspection before its replacement is published", async () => {
  const recognition = cacheHarness();
  let signal: AbortSignal | undefined;
  vi.mocked(inspectPreviewSvg).mockImplementationOnce((_source, options) => {
    signal = options.signal;
    return new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve(null)));
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
    (_source, options) =>
      new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve(null))),
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
