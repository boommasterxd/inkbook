import {
  normalizePath,
  Notice,
  Platform,
  Plugin,
  TFile,
  TFolder,
} from "obsidian";

import { openIndexedDbRecoveryStore } from "./adapters/recovery-indexed-db";
import { ObsidianEditorNoteIdentityResolverV1 } from "./adapters/obsidian/editor-note-identity";
import {
  PluginRuntime,
  type PluginRuntimePersistenceV1,
} from "./adapters/obsidian/plugin-runtime";
import {
  resolveRuntimeSidecarMarkerV1,
  type RuntimeSidecarResolutionV1,
} from "./adapters/obsidian/runtime-persistence-open";
import type { RuntimeExternalChangeVaultV1 } from "./adapters/obsidian/runtime-external-change";
import {
  OrphanSidecarReviewer,
  type OrphanReviewContinuationV1,
} from "./adapters/obsidian/vault-sidecar/events";
import {
  loadObsidianSidecarStoragePolicyV1,
  ObsidianVaultIdentityPortV1,
  recoveryDatabaseNameV1,
} from "./adapters/obsidian/settings";
import type { VaultFileCapability } from "./adapters/obsidian/vault-sidecar/paths";
import { ObsidianSidecarTrashPortV1 } from "./adapters/obsidian/vault-sidecar/removal-trash";
import type { SidecarStoragePolicyStoreV1 } from "./application/persistence";
import type { NoteIdentityV1 } from "./application/note-session";
import { createSharedWorkerPortsV1 } from "./workers/shared-worker-ports";
import type { WorkerSliceMode } from "./workers/scheduler/protocol";
import type { WorkerSliceScheduler } from "./workers/scheduler/scheduler-types";

const WORKER_TRANSPORT_REVISION = Object.freeze({ layout: 0, scene: 0 });

class PluginLifecycleToken {
  #active = true;

  public isActive(): boolean {
    return this.#active;
  }

  public invalidate(): void {
    this.#active = false;
  }
}

export default class InkbookPlugin extends Plugin {
  readonly #lifecycle = new PluginLifecycleToken();
  #initialization: Promise<void> | undefined;
  #orphanReviewContinuation: OrphanReviewContinuationV1 | null = null;
  #runtime: PluginRuntime | undefined;
  #runtimeLoad: Promise<PluginRuntime | null> | undefined;
  #storagePolicy: SidecarStoragePolicyStoreV1 | undefined;

  public override onload(): Promise<void> {
    this.#initialization ??= this.#initialize();
    return this.#initialization;
  }

  public override onunload(): void {
    this.#lifecycle.invalidate();
    this.#orphanReviewContinuation = null;
    void this.#runtime?.dispose();
    this.#runtime = undefined;
  }

  async #initialize(): Promise<void> {
    const storagePolicy = await loadObsidianSidecarStoragePolicyV1(this);
    if (!this.#lifecycle.isActive()) return;
    this.#storagePolicy = storagePolicy;
    this.#registerCommands();
    this.app.workspace.onLayoutReady(() => {
      if (!this.#lifecycle.isActive()) return;
      void this.#ensureRuntime().catch(() => undefined);
    });
  }

  #registerCommands(): void {
    if (!this.#lifecycle.isActive()) return;
    this.addCommand({
      id: "review-sidecar-candidates",
      name: "Review sidecar candidates",
      callback: (): Promise<void> => this.#reviewSidecarCandidates(),
    });
  }

  async #reviewSidecarCandidates(): Promise<void> {
    try {
      const runtime = await this.#ensureRuntime();
      if (!this.#lifecycle.isActive()) return;
      const maintenance = runtime?.maintenance;
      if (maintenance === null || maintenance === undefined) {
        new Notice("Sidecar review is unavailable for this Vault.");
        return;
      }
      const continuation = this.#orphanReviewContinuation;
      const result =
        continuation === null
          ? await maintenance.reviewOrphans()
          : await maintenance.continueOrphanReview(continuation);
      if (!this.#lifecycle.isActive()) return;
      if (result.kind === "stale-continuation") {
        this.#orphanReviewContinuation = null;
        new Notice("Sidecar candidates changed; start a new review.");
        return;
      }
      if (result.kind === "cancelled") {
        new Notice("Sidecar review was cancelled.");
        return;
      }
      this.#orphanReviewContinuation = result.continuation;
      const nextStep = result.requiresContinuation
        ? " The candidate limit was reached; run the command again to continue."
        : "";
      const fileLabel =
        result.inspectedFiles === 1 ? "Vault file" : "Vault files";
      const candidateLabel =
        result.candidates.length === 1
          ? "sidecar candidate"
          : "sidecar candidates";
      new Notice(
        `Reviewed ${String(result.inspectedFiles)} ${fileLabel} and found ${String(result.candidates.length)} ${candidateLabel}.${nextStep}`,
      );
    } catch {
      if (this.#lifecycle.isActive()) {
        new Notice("Sidecar review could not be completed.");
      }
    }
  }

  async #ensureRuntime(): Promise<PluginRuntime | null> {
    if (!this.#lifecycle.isActive()) return null;
    if (this.#runtime !== undefined) return this.#runtime;
    if (this.#runtimeLoad !== undefined) return this.#runtimeLoad;
    const storagePolicy = this.#storagePolicy;
    if (storagePolicy === undefined) return null;
    const loading = this.#createRuntime(storagePolicy);
    this.#runtimeLoad = loading;
    try {
      return await loading;
    } finally {
      if (this.#runtimeLoad === loading) this.#runtimeLoad = undefined;
    }
  }

  async #createRuntime(
    storagePolicy: SidecarStoragePolicyStoreV1,
  ): Promise<PluginRuntime | null> {
    if (!this.#lifecycle.isActive()) return null;
    const vaultId = new ObsidianVaultIdentityPortV1(this.app).resolve();
    const databaseName = recoveryDatabaseNameV1(vaultId);
    const opened =
      databaseName === null
        ? null
        : await openIndexedDbRecoveryStore({ databaseName });
    if (!this.#lifecycle.isActive()) {
      if (opened?.ok === true) await opened.value.dispose();
      return null;
    }
    const persistence =
      opened?.ok === true
        ? createRuntimePersistence(this, storagePolicy)
        : null;
    const runtime = new PluginRuntime(this, {
      ...(vaultId === null
        ? {}
        : {
            noteIdentityResolver: new ObsidianEditorNoteIdentityResolverV1(
              this.app,
              vaultId,
            ),
          }),
      ...(vaultId === null ? {} : { vaultId }),
      ...(persistence === null ? {} : { persistence }),
      recoveryStore: opened?.ok === true ? opened.value : null,
      storagePolicy,
    });
    try {
      await runtime.resumeRelocations();
      if (!this.#lifecycle.isActive()) {
        await runtime.dispose();
        return null;
      }
      runtime.register();
      this.#runtime = runtime;
      return runtime;
    } catch (error: unknown) {
      await runtime.dispose();
      throw error;
    }
  }
}

function createRuntimePersistence(
  plugin: InkbookPlugin,
  storagePolicy: SidecarStoragePolicyStoreV1,
): PluginRuntimePersistenceV1 {
  const environment = browserWorkerEnvironment();
  const workers = createSharedWorkerPortsV1({
    clock: { now: (): number => performance.now() },
    environment,
    isCurrent: (revision): boolean =>
      revision.layout === WORKER_TRANSPORT_REVISION.layout &&
      revision.scene === WORKER_TRANSPORT_REVISION.scene,
    readRevision: () => WORKER_TRANSPORT_REVISION,
    slices: workerSlices(),
  });
  const vault = sidecarVault(plugin);
  const orphanReviewer = new OrphanSidecarReviewer(
    { getFiles: (): readonly TFile[] => plugin.app.vault.getFiles() },
    {
      now: (): number => performance.now(),
      yieldControl: (): Promise<void> =>
        new Promise((resolve) => globalThis.setTimeout(resolve, 0)),
    },
  );
  const persistence: PluginRuntimePersistenceV1 = {
    disposeOwned: (): void => {
      orphanReviewer.dispose();
      workers.dispose();
    },
    externalVault: vault,
    orphanReviewer,
    persistenceCodecPort: workers.persistenceCodec,
    relocation: relocationHost(plugin),
    resolveSidecar: (identity: NoteIdentityV1): RuntimeSidecarResolutionV1 =>
      resolveRuntimeSidecar(plugin, storagePolicy, identity),
    sourceDigestWorkPort: workers.sourceDigest,
    sourceMapWorkPort: workers.sourceMapWork,
    vault,
    writableTier: Platform.isPhone ? "phone" : "desktop-tablet",
  };
  return Object.freeze(persistence);
}

function relocationHost(
  plugin: InkbookPlugin,
): PluginRuntimePersistenceV1["relocation"] {
  const resolveMarkdownFile = (path: string): TFile | null => {
    const entry = plugin.app.vault.getAbstractFileByPath(path);
    return entry instanceof TFile ? entry : null;
  };
  return Object.freeze({
    markerHost: {
      normalizePath,
      processFrontMatter: (file, callback): Promise<void> =>
        plugin.app.fileManager.processFrontMatter(requireFile(file), callback),
    },
    resolveMarkdownFile,
    trash: new ObsidianSidecarTrashPortV1(
      plugin.app.vault,
      plugin.app.fileManager,
    ),
    vault: {
      createFolder: async (path): Promise<void> => {
        await plugin.app.vault.createFolder(path);
      },
      getFileByPath: (path) => {
        const entry = plugin.app.vault.getAbstractFileByPath(path);
        return entry instanceof TFile || entry instanceof TFolder
          ? entry
          : null;
      },
      normalizePath,
      rename: (file, destinationPath): Promise<void> =>
        plugin.app.fileManager.renameFile(requireFile(file), destinationPath),
    },
  });
}

function resolveRuntimeSidecar(
  plugin: InkbookPlugin,
  storagePolicy: SidecarStoragePolicyStoreV1,
  identity: NoteIdentityV1,
): RuntimeSidecarResolutionV1 {
  const file = plugin.app.vault.getAbstractFileByPath(
    identity.vaultRelativeMarkdownPath,
  );
  if (!(file instanceof TFile)) return { kind: "blocked" };
  const metadataCache = plugin.app.metadataCache as
    | {
        getFileCache(target: TFile): { readonly frontmatter?: unknown } | null;
      }
    | undefined;
  const cache = metadataCache?.getFileCache(file) ?? null;
  return resolveRuntimeSidecarMarkerV1({
    identity,
    metadata:
      cache === null
        ? { kind: "unavailable" }
        : { kind: "available", frontmatter: cache.frontmatter },
    normalizePath,
    policy: storagePolicy.snapshot.policy,
  });
}

function sidecarVault(plugin: InkbookPlugin): RuntimeExternalChangeVaultV1 {
  const capability: RuntimeExternalChangeVaultV1 = {
    cachedRead: (file: VaultFileCapability): Promise<string> =>
      plugin.app.vault.cachedRead(requireFile(file)),
    create: (path: string, contents: string) =>
      plugin.app.vault.create(path, contents),
    createFolder: async (path: string): Promise<void> => {
      await plugin.app.vault.createFolder(path);
    },
    getFileByPath: (path: string) => {
      const file = plugin.app.vault.getAbstractFileByPath(path);
      return file instanceof TFile || file instanceof TFolder ? file : null;
    },
    getFolderByPath: (path: string) => {
      const file = plugin.app.vault.getAbstractFileByPath(path);
      return file instanceof TFolder ? file : null;
    },
    getFiles: () => plugin.app.vault.getFiles(),
    normalizePath,
    process: (
      file: VaultFileCapability,
      callback: (currentText: string) => string,
    ): Promise<string> => plugin.app.vault.process(requireFile(file), callback),
  };
  return Object.freeze(capability);
}

function requireFile(file: { readonly path: string }): TFile {
  const resolved = file;
  if (!(resolved instanceof TFile)) {
    throw new TypeError("The Vault capability is not a concrete TFile.");
  }
  return resolved;
}

function browserWorkerEnvironment():
  Parameters<typeof createSharedWorkerPortsV1>[0]["environment"] | null {
  if (
    typeof globalThis.Blob !== "function" ||
    typeof globalThis.Worker !== "function" ||
    typeof globalThis.URL.createObjectURL !== "function" ||
    typeof globalThis.URL.revokeObjectURL !== "function"
  )
    return null;
  return {
    Blob: globalThis.Blob,
    URL: globalThis.URL,
    Worker: globalThis.Worker,
  };
}

function workerSlices(): WorkerSliceScheduler {
  return {
    schedule: (mode, callback): (() => void) =>
      scheduleWorkerSlice(mode, callback),
  };
}

function scheduleWorkerSlice(
  mode: WorkerSliceMode,
  callback: () => void,
): () => void {
  if (mode === "idle" && typeof globalThis.requestIdleCallback === "function") {
    const handle = globalThis.requestIdleCallback(callback);
    return (): void => globalThis.cancelIdleCallback(handle);
  }
  const handle = globalThis.setTimeout(callback, 0);
  return (): void => globalThis.clearTimeout(handle);
}
