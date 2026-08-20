// @vitest-environment happy-dom

import { Notice, type App, type PluginManifest, TFile } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface CapturedWorkerOptions {
  readonly environment: unknown;
  readonly slices: {
    schedule(mode: "active" | "idle", callback: () => void): () => void;
  };
}
interface DisposeSpy {
  readonly mock: {
    readonly results: readonly { readonly value?: unknown }[];
  };
}
const moduleState = vi.hoisted(() => ({
  loadPolicy: vi.fn(),
  openRecovery: vi.fn(),
  realLoadPolicy: undefined as
    ((value: unknown) => Promise<unknown>) | undefined,
  workerOptions: undefined as CapturedWorkerOptions | undefined,
}));
vi.mock("../src/adapters/obsidian/settings", async () => {
  const actual = await vi.importActual<
    typeof import("../src/adapters/obsidian/settings")
  >("../src/adapters/obsidian/settings");
  moduleState.realLoadPolicy =
    actual.loadObsidianSidecarStoragePolicyV1 as unknown as (
      value: unknown,
    ) => Promise<unknown>;
  moduleState.loadPolicy.mockImplementation((plugin: unknown) =>
    (moduleState.realLoadPolicy as (value: unknown) => Promise<unknown>)(
      plugin,
    ),
  );
  return {
    ...actual,
    loadObsidianSidecarStoragePolicyV1: moduleState.loadPolicy,
  };
});
vi.mock("../src/adapters/recovery-indexed-db", async () => {
  const actual = await vi.importActual<
    typeof import("../src/adapters/recovery-indexed-db")
  >("../src/adapters/recovery-indexed-db");
  return { ...actual, openIndexedDbRecoveryStore: moduleState.openRecovery };
});
vi.mock("../src/workers/static-worker-source", () => ({
  readStaticSharedWorkerSource: vi.fn(
    () => "self.onmessage = () => undefined;",
  ),
}));
vi.mock("../src/workers/shared-worker-ports", async () => {
  const actual = await vi.importActual<
    typeof import("../src/workers/shared-worker-ports")
  >("../src/workers/shared-worker-ports");
  return {
    ...actual,
    createSharedWorkerPortsV1: (
      options: unknown,
    ): ReturnType<typeof actual.createSharedWorkerPortsV1> => {
      moduleState.workerOptions = options as CapturedWorkerOptions;
      return actual.createSharedWorkerPortsV1(
        options as Parameters<typeof actual.createSharedWorkerPortsV1>[0],
      );
    },
  };
});
import { PluginRuntime } from "../src/adapters/obsidian/plugin-runtime";
import { OrphanSidecarReviewer } from "../src/adapters/obsidian/vault-sidecar/events";
import InkbookPlugin from "../src/main";

const VAULT_ID = "0123456789abcdef0123456789abcdef";
const ONE_PREVIOUS_RESULT = 1;
const EXPECTED_CONTINUATIONS = Number("2");
const IDLE_HANDLE = Number("7");

interface RegisteredCommand {
  readonly callback?: () => unknown;
  readonly id: string;
}

interface PluginHarness {
  readonly app: Record<string, unknown>;
  readonly onLayoutReady: ReturnType<typeof vi.fn>;
  readonly plugin: InkbookPlugin;
  runLayoutReady(): void;
}

function createPlugin(
  options: { readonly vaultId?: string | null } = {},
): PluginHarness {
  let layoutReady: (() => void) | undefined;
  const onLayoutReady = vi.fn((callback: () => void): void => {
    layoutReady = callback;
  });
  const files: TFile[] = [];
  const vault = {
    cachedRead: vi.fn(async (): Promise<string> => ""),
    create: vi.fn(async (): Promise<TFile> => new TFile()),
    createFolder: vi.fn(async (): Promise<void> => undefined),
    getAbstractFileByPath: vi.fn(() => null),
    getFiles: vi.fn(() => files),
    on: vi.fn((event: string) => ({ event })),
    process: vi.fn(async (): Promise<string> => ""),
  };
  const app = {
    fileManager: {
      processFrontMatter: vi.fn(
        async (_file: TFile, callback: (frontmatter: unknown) => void) => {
          callback({});
        },
      ),
      renameFile: vi.fn(async (): Promise<void> => undefined),
      trashFile: vi.fn(async (): Promise<void> => undefined),
    },
    loadLocalStorage: vi.fn(() =>
      options.vaultId === undefined ? VAULT_ID : options.vaultId,
    ),
    metadataCache: { getFileCache: vi.fn(() => null) },
    saveLocalStorage: vi.fn(),
    vault,
    workspace: { onLayoutReady },
  };
  const plugin = new InkbookPlugin(
    app as unknown as App,
    { id: "inkbook" } as PluginManifest,
  );
  return {
    app,
    onLayoutReady,
    plugin,
    runLayoutReady: (): void => layoutReady?.(),
  };
}

function resetModules(): void {
  moduleState.loadPolicy.mockReset();
  moduleState.loadPolicy.mockImplementation((plugin: unknown) =>
    (moduleState.realLoadPolicy as (value: unknown) => Promise<unknown>)(
      plugin,
    ),
  );
  moduleState.openRecovery.mockReset();
  moduleState.openRecovery.mockResolvedValue({
    code: "recovery-unavailable",
    ok: false,
  });
  moduleState.workerOptions = undefined;
}

function commandFor(plugin: InkbookPlugin): RegisteredCommand {
  const commands = (
    plugin as unknown as { readonly commands: RegisteredCommand[] }
  ).commands;
  const command = commands.find(({ id }) => id === "review-sidecar-candidates");
  if (command === undefined)
    throw new Error("Review command was not registered.");
  return command;
}

async function invokeReview(plugin: InkbookPlugin): Promise<void> {
  await commandFor(plugin).callback?.();
}

function recoveryStore(): { readonly dispose: ReturnType<typeof vi.fn> } {
  const dispose = vi.fn(async (): Promise<void> => undefined);
  moduleState.openRecovery.mockResolvedValue({
    ok: true,
    value: { dispose } as never,
  });
  return { dispose };
}

async function unload(
  plugin: InkbookPlugin,
  disposeSpy?: DisposeSpy,
): Promise<void> {
  plugin.onunload();
  const lastResult: unknown =
    disposeSpy?.mock.results.at(-ONE_PREVIOUS_RESULT)?.value;
  if (lastResult instanceof Promise) await lastResult;
}

async function startPersistent(): Promise<{
  readonly harness: PluginHarness;
  readonly store: { readonly dispose: ReturnType<typeof vi.fn> };
}> {
  const store = recoveryStore();
  const resume = vi.spyOn(PluginRuntime.prototype, "resumeRelocations");
  resume.mockResolvedValue(undefined);
  const harness = createPlugin();
  await harness.plugin.onload();
  await invokeReview(harness.plugin);
  noticeMessages().splice(0);
  resume.mockRestore();
  return { harness, store };
}

function noticeMessages(): string[] {
  return (Notice as unknown as { readonly messages: string[] }).messages;
}

function capturedWorkerOptions(): CapturedWorkerOptions {
  const options = moduleState.workerOptions;
  if (options === undefined)
    throw new Error("Worker options were not composed.");
  return options;
}

beforeEach(() => {
  noticeMessages().splice(0);
  resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("main composition failure branches", () => {
  it("fails closed when the Vault identity is unavailable", async () => {
    const harness = createPlugin({ vaultId: null });
    await harness.plugin.onload();

    await invokeReview(harness.plugin);

    expect(moduleState.openRecovery).not.toHaveBeenCalled();
    expect(noticeMessages()).toEqual([
      "Sidecar review is unavailable for this Vault.",
    ]);
    await unload(harness.plugin);
  });

  it("reports an unavailable maintenance runtime after recovery open failure", async () => {
    const harness = createPlugin();
    await harness.plugin.onload();
    harness.runLayoutReady();

    await invokeReview(harness.plugin);

    expect(moduleState.openRecovery).toHaveBeenCalledOnce();
    expect(noticeMessages()).toEqual([
      "Sidecar review is unavailable for this Vault.",
    ]);
    await unload(harness.plugin);
  });

  it("returns an unavailable runtime when settings are absent", async () => {
    moduleState.loadPolicy.mockResolvedValue(undefined);
    const harness = createPlugin();
    await harness.plugin.onload();

    await invokeReview(harness.plugin);

    expect(moduleState.openRecovery).not.toHaveBeenCalled();
    expect(noticeMessages()).toEqual([
      "Sidecar review is unavailable for this Vault.",
    ]);
  });

  it("propagates settings-load failures without registering layout work", async () => {
    moduleState.loadPolicy.mockRejectedValue(new Error("settings unavailable"));
    const harness = createPlugin();

    await expect(harness.plugin.onload()).rejects.toThrow(
      "settings unavailable",
    );

    expect(harness.onLayoutReady).not.toHaveBeenCalled();
  });
});

describe("main composition lifecycle races", () => {
  it("shares one pending runtime load between layout and command callers", async () => {
    let resolveOpen: ((value: unknown) => void) | undefined;
    const pending = new Promise((resolve) => {
      resolveOpen = resolve;
    });
    moduleState.openRecovery.mockReturnValue(pending);
    const harness = createPlugin();
    await harness.plugin.onload();
    harness.runLayoutReady();
    const review = invokeReview(harness.plugin);

    expect(moduleState.openRecovery).toHaveBeenCalledOnce();
    resolveOpen?.({ code: "recovery-unavailable", ok: false });
    await review;

    expect(noticeMessages()).toEqual([
      "Sidecar review is unavailable for this Vault.",
    ]);
    await unload(harness.plugin);
  });

  it("disposes an opened recovery store when unload wins the race", async () => {
    let resolveOpen: ((value: unknown) => void) | undefined;
    const pending = new Promise((resolve) => {
      resolveOpen = resolve;
    });
    moduleState.openRecovery.mockReturnValue(pending);
    const harness = createPlugin();
    await harness.plugin.onload();
    const review = invokeReview(harness.plugin);
    const store = recoveryStore();
    harness.plugin.onunload();
    resolveOpen?.({ ok: true, value: { dispose: store.dispose } });
    await review;

    expect(store.dispose).toHaveBeenCalledOnce();
  });

  it("disposes a runtime after relocation resume fails", async () => {
    const resume = vi.spyOn(PluginRuntime.prototype, "resumeRelocations");
    const dispose = vi.spyOn(PluginRuntime.prototype, "dispose");
    resume.mockRejectedValue(new Error("relocation resume failed"));
    const harness = createPlugin();
    await harness.plugin.onload();

    await invokeReview(harness.plugin);

    expect(dispose).toHaveBeenCalledOnce();
    expect(noticeMessages()).toEqual([
      "Sidecar review could not be completed.",
    ]);
    await unload(harness.plugin, dispose);
  });

  it("disposes a runtime when unload occurs after relocation resume", async () => {
    const dispose = vi.spyOn(PluginRuntime.prototype, "dispose");
    const harness = createPlugin();
    const resume = vi.spyOn(PluginRuntime.prototype, "resumeRelocations");
    resume.mockImplementation(async () => {
      harness.plugin.onunload();
    });
    await harness.plugin.onload();

    await invokeReview(harness.plugin);

    expect(dispose).toHaveBeenCalledOnce();
    expect(noticeMessages()).toEqual([]);
  });

  it("ignores a command completion after unload", async () => {
    const harness = createPlugin();
    await harness.plugin.onload();
    harness.plugin.onunload();

    await invokeReview(harness.plugin);

    expect(noticeMessages()).toEqual([]);
    expect(moduleState.openRecovery).not.toHaveBeenCalled();
  });
});

describe("main worker composition branches", () => {
  it("constructs persistence with no browser worker APIs and uses timeout slices", async () => {
    const store = recoveryStore();
    vi.stubGlobal("Blob", undefined);
    vi.stubGlobal("Worker", undefined);
    vi.stubGlobal("URL", {});
    const dispose = vi.spyOn(PluginRuntime.prototype, "dispose");
    const resume = vi.spyOn(PluginRuntime.prototype, "resumeRelocations");
    resume.mockResolvedValue(undefined);
    const harness = createPlugin();

    await harness.plugin.onload();
    await invokeReview(harness.plugin);

    const options = capturedWorkerOptions();
    expect(options.environment).toBeNull();
    options.slices.schedule("active", vi.fn())();
    options.slices.schedule("idle", vi.fn())();
    await unload(harness.plugin, dispose);
    expect(store.dispose).toHaveBeenCalledOnce();
  });

  it("constructs browser worker APIs and cancels idle slices", async () => {
    const store = recoveryStore();
    const createObjectURL = vi.fn(() => "blob:inkbook");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("Blob", vi.fn());
    vi.stubGlobal("Worker", vi.fn());
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const requestIdleCallback = vi.fn(() => IDLE_HANDLE);
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);
    const dispose = vi.spyOn(PluginRuntime.prototype, "dispose");
    const resume = vi.spyOn(PluginRuntime.prototype, "resumeRelocations");
    resume.mockResolvedValue(undefined);
    const harness = createPlugin();

    await harness.plugin.onload();
    await invokeReview(harness.plugin);

    const options = capturedWorkerOptions();
    if (
      options.environment === null ||
      typeof options.environment !== "object" ||
      !("Worker" in options.environment)
    ) {
      throw new Error("Browser worker environment was not composed.");
    }
    expect(options.environment.Worker).toBeDefined();
    const cancel = options.slices.schedule("idle", vi.fn());
    cancel();
    options.slices.schedule("active", vi.fn())();
    expect(requestIdleCallback).toHaveBeenCalledOnce();
    expect(cancelIdleCallback).toHaveBeenCalledWith(IDLE_HANDLE);
    await unload(harness.plugin, dispose);
    expect(store.dispose).toHaveBeenCalledOnce();
  });
});

describe("main orphan review branches", () => {
  it("reports cancelled orphan reviews", async () => {
    const { harness } = await startPersistent();
    const review = vi.spyOn(OrphanSidecarReviewer.prototype, "review");
    review.mockResolvedValue({ kind: "cancelled" });

    await invokeReview(harness.plugin);

    expect(noticeMessages()).toEqual(["Sidecar review was cancelled."]);
    await unload(harness.plugin);
  });

  it("reports orphan review errors", async () => {
    const { harness } = await startPersistent();
    const review = vi.spyOn(OrphanSidecarReviewer.prototype, "review");
    review.mockRejectedValue(new Error("review failed"));

    await invokeReview(harness.plugin);

    expect(noticeMessages()).toEqual([
      "Sidecar review could not be completed.",
    ]);
    const runtimeDispose = vi.spyOn(PluginRuntime.prototype, "dispose");
    await unload(harness.plugin, runtimeDispose);
  });

  it("handles cancellation and failure while continuing an orphan review", async () => {
    const store = recoveryStore();
    const resume = vi.spyOn(PluginRuntime.prototype, "resumeRelocations");
    resume.mockResolvedValue(undefined);
    const harness = createPlugin();
    await harness.plugin.onload();
    const review = vi.spyOn(OrphanSidecarReviewer.prototype, "review");
    const continuation = {
      nextIndex: 1,
      priorPath: "Notes/one.inkbook.json",
      reviewId: 1,
      totalFiles: 2,
    };
    review.mockResolvedValue({
      candidates: [],
      continuation,
      inspectedFiles: 1,
      kind: "complete",
      requiresContinuation: true,
    });
    const continueReview = vi.spyOn(
      OrphanSidecarReviewer.prototype,
      "continueReview",
    );
    await invokeReview(harness.plugin);
    continueReview.mockResolvedValue({ kind: "cancelled" });
    await invokeReview(harness.plugin);
    continueReview.mockRejectedValue(new Error("continuation failed"));
    await invokeReview(harness.plugin);

    expect(continueReview).toHaveBeenCalledTimes(EXPECTED_CONTINUATIONS);
    expect(noticeMessages()).toEqual([
      "Reviewed 1 Vault file and found 0 sidecar candidates. The candidate limit was reached; run the command again to continue.",
      "Sidecar review was cancelled.",
      "Sidecar review could not be completed.",
    ]);
    const runtimeDispose = vi.spyOn(PluginRuntime.prototype, "dispose");
    await unload(harness.plugin, runtimeDispose);
    expect(store.dispose).toHaveBeenCalledOnce();
  });

  it("disposes orphan reviewers and worker ports exactly once", async () => {
    const { harness, store } = await startPersistent();
    const reviewerDispose = vi.spyOn(
      OrphanSidecarReviewer.prototype,
      "dispose",
    );
    const runtimeDispose = vi.spyOn(PluginRuntime.prototype, "dispose");

    await unload(harness.plugin, runtimeDispose);
    await unload(harness.plugin, runtimeDispose);

    expect(runtimeDispose).toHaveBeenCalledOnce();
    expect(reviewerDispose).toHaveBeenCalledOnce();
    expect(store.dispose).toHaveBeenCalledOnce();
  });
});
