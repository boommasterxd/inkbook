import { TFile } from "obsidian";

import { validateSerializedSceneStateV1 } from "../../domain/codecs";
import { createSceneRevision } from "../../domain/model";
import {
  createRuntimeSceneStateV1,
  type RuntimeSceneStateV1,
} from "../../domain/scene";
import { replayMaterializedRecoveryHistory } from "../../application/host-history";
import {
  commandFailure,
  commandSuccess,
  type CommandResultV1,
  type NoteSessionV1,
  type RelocationId,
} from "../../application/note-session";
import {
  PersistenceDecodedBytePoolV1,
  type ExternalConflictChoiceV1,
} from "../../application/persistence";
import {
  type ActiveRemovalRecoveryV1,
  type RemovalRecordV1,
  type SidecarBaseIdentityV1,
} from "../../application/recovery";
import {
  tryProjectRuntimePersistenceIssueStatus,
  type ConflictStatusV1,
  type DriftStatusV1,
  type RetryStatusV1,
} from "../../ui/status";
import {
  bindRuntimeExternalSidecarChangeV1,
  type RuntimeExternalReloadV1,
  type RuntimeExternalSidecarChangeV1,
} from "./runtime-external-change";
import type { RuntimePersistenceExternalStateV1 } from "./runtime-persistence-external-state";
import type { ObsidianVaultChangeV1 } from "./vault-sidecar/host-events";
import type { PreparedSidecarWrite } from "./vault-sidecar/repository";
import type { SidecarMarkerWriter } from "./vault-sidecar/marker";
import { RuntimeRemovalV1 } from "./runtime-removal";
import type {
  RuntimePersistenceConfigV1,
  RuntimeSessionHistoryV1,
} from "./runtime-session";

export type RuntimePersistenceHistoryV1 = Pick<
  RuntimeSessionHistoryV1,
  | "initialize"
  | "prepareDispatch"
  | "replaceAfterExternalReload"
  | "updatePersistenceContext"
> &
  Partial<Pick<RuntimeSessionHistoryV1, "bindSourceMaterialization">>;

export interface RuntimePersistenceIssueStatusV1 {
  readonly conflict: ConflictStatusV1;
  readonly drift: DriftStatusV1;
  readonly retry: RetryStatusV1;
}

const CLEAR_ISSUE_STATUS: RuntimePersistenceIssueStatusV1 = Object.freeze({
  conflict: Object.freeze({ kind: "none" }),
  drift: Object.freeze({ kind: "none" }),
  retry: Object.freeze({ kind: "not-required" }),
});
type RuntimeRetryActionV1 = Extract<
  RetryStatusV1,
  { readonly kind: "available" }
>["action"];

export {
  createRuntimePersistenceExternalStateV1,
  RuntimeOwnedSidecarWriteV1,
  type RuntimePersistenceExternalStateV1,
} from "./runtime-persistence-external-state";

export interface RuntimePersistenceExternalOptionsV1 {
  readonly config: RuntimePersistenceConfigV1;
  readonly consumeOwnedWrite: (base: SidecarBaseIdentityV1) => boolean;
  readonly history: RuntimePersistenceHistoryV1;
  readonly marker: Pick<SidecarMarkerWriter, "remove">;
  readonly onRemoved: (base: SidecarBaseIdentityV1) => void;
  readonly onReload: (
    reload: RuntimeExternalReloadV1,
    scene: RuntimeSceneStateV1,
  ) => void;
  readonly readState: () => RuntimePersistenceExternalStateV1 | null;
  readonly session: NoteSessionV1;
}

export class RuntimePersistenceExternalV1 {
  readonly #external: RuntimeExternalSidecarChangeV1 | null;
  readonly #options: RuntimePersistenceExternalOptionsV1;
  readonly #removal: RuntimeRemovalV1 | null;
  #removalReady: Promise<void> = Promise.resolve();
  #issueStatus = CLEAR_ISSUE_STATUS;
  #retryAction: RuntimeRetryActionV1 | null = null;
  #retryAttempts = 0;

  public constructor(options: RuntimePersistenceExternalOptionsV1) {
    this.#options = options;
    this.#external = bindRuntimeExternalSidecarChangeV1(options.config, {
      consumeOwnedWrite: options.consumeOwnedWrite,
      decodedBytes: new PersistenceDecodedBytePoolV1(),
      prepareLocalConflictCopy: () => this.#prepareLocalCopy(),
      publishConflict: () => this.#publishConflict(),
      publishMissingDrift: (drift) =>
        this.#publishDrift(
          drift.movedPath === null ? "sidecar-deleted" : "sidecar-renamed",
        ),
      publishReload: (reload) => this.#publishReload(reload),
      publishUnreadableConflict: () => this.#publishConflict("reload"),
      readContext: () => this.#readContext(),
      remainReadOnly: () => this.#publishConflict(),
    });
    this.#removal = this.#createRemoval();
  }

  public get issueStatus(): RuntimePersistenceIssueStatusV1 {
    const projected = tryProjectRuntimePersistenceIssueStatus(
      this.#issueStatus,
    );
    return projected.ok ? projected.value : CLEAR_ISSUE_STATUS;
  }

  public get mutationBlocked(): boolean {
    return (
      (this.#external !== null && this.#external.pendingConflict !== null) ||
      this.#removal?.hasActiveRemoval === true
    );
  }

  public resumeRemoval(bundle: ActiveRemovalRecoveryV1): void {
    if (this.#removal !== null)
      this.#removalReady = this.#resumeRemoval(bundle);
  }

  public async accept(
    change: ObsidianVaultChangeV1,
    ownedRelocationId: RelocationId | null = null,
  ): Promise<CommandResultV1<unknown>> {
    await this.#removalReady;
    const state = this.#options.readState();
    if (
      change.kind === "delete" &&
      change.target instanceof TFile &&
      change.target.path === state?.base.vaultRelativePath
    ) {
      const removal = this.#removal?.acceptActiveDelete(state.base);
      if (removal !== null && removal !== undefined) {
        const result = await removal;
        await this.#removal?.whenIdle();
        if (result.consumed && this.#removal?.hasActiveRemoval === true) {
          await this.#publishDrift("marker-invalid", "marker");
        }
        return commandSuccess(result);
      }
    }
    return (
      this.#external?.accept(change, ownedRelocationId) ??
      Promise.resolve(commandFailure("sidecar-conflict"))
    );
  }

  public async startRemoval(
    record: RemovalRecordV1,
  ): Promise<CommandResultV1<void>> {
    await this.#removalReady;
    if (this.#removal === null) return commandFailure("read-only-mode");
    const priorRetryAttempts = this.#retryAttempts;
    const result = await this.#removal.start(record);
    if (!result.ok && this.#retryAttempts === priorRetryAttempts) {
      this.#recordRetry("removal");
    }
    return result;
  }

  public async retryRemovalCleanup(): Promise<CommandResultV1<void>> {
    await this.#removalReady;
    if (this.#removal === null || !this.#removal.hasActiveRemoval) {
      return commandFailure("invalid-command");
    }
    const result = await this.#removal.retryCleanup();
    if (!result.ok) {
      await this.#publishDrift("marker-invalid", "marker");
    } else {
      this.#clearCompletedRemovalIssue();
    }
    return result;
  }

  public resolve(
    choice: ExternalConflictChoiceV1,
  ): Promise<CommandResultV1<void>> {
    return (
      this.#external?.resolve(choice) ??
      Promise.resolve(commandFailure("sidecar-conflict"))
    );
  }

  public async dispose(): Promise<void> {
    this.#external?.dispose();
    await this.#removal?.dispose();
  }

  #createRemoval(): RuntimeRemovalV1 | null {
    const trash = this.#options.config.removalTrash;
    if (trash === undefined) return null;
    return new RuntimeRemovalV1({
      callbacks: {
        clearSession: (record) => this.#clearRemoval(record),
        handleExternalDelete: () => this.#publishDrift("sidecar-deleted"),
        resolveFailure: async (): Promise<CommandResultV1<void>> => {
          this.#recordRetry("removal");
          return commandSuccess(undefined);
        },
      },
      clock: {
        clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
        now: () => Date.now(),
        setTimeout: (callback, delayMs) =>
          globalThis.setTimeout(callback, delayMs),
      },
      marker: this.#options.marker,
      recovery: this.#options.config.recovery,
      resolveMarkdownFile: (identity) =>
        this.#options.config.resolveMarkdownFile(
          identity.vaultRelativeMarkdownPath,
        ),
      trash,
    });
  }

  #readContext():
    import("./runtime-external-change").RuntimeExternalChangeContextV1 | null {
    const state = this.#options.readState();
    if (state === null) return null;
    return {
      activeRelocation: state.activeRelocation,
      expectedBase: state.base,
      noteIdentity: state.identity,
      recoveryLoadRequest: {
        base: state.base,
        currentMarkdownDigest: state.sourceDigest,
        currentMarkdownUtf16Length: state.sourceUtf16Length,
        kind: "existing-sidecar",
        noteIdentity: state.identity,
        validatedSidecarSourceDigest: state.sourceDigest,
        validatedSidecarSourceGeneration: state.sourceGeneration,
      },
    };
  }

  async #resumeRemoval(bundle: ActiveRemovalRecoveryV1): Promise<void> {
    if (this.#removal === null) {
      this.#recordRetry("removal");
      return;
    }
    const priorRetryAttempts = this.#retryAttempts;
    const resumed = await this.#removal.resume(bundle);
    if (!resumed.ok) {
      if (this.#retryAttempts === priorRetryAttempts) {
        this.#recordRetry("removal");
      }
      return;
    }
    await this.#removal.whenIdle();
    if (this.#removal.hasActiveRemoval) {
      await this.#publishDrift("marker-invalid", "marker");
    }
  }

  async #clearRemoval(record: RemovalRecordV1): Promise<CommandResultV1<void>> {
    const state = this.#options.readState();
    if (state?.base.vaultRelativePath !== record.sidecarBase.vaultRelativePath)
      return commandFailure("sidecar-drift");
    const scene = emptyScene(Number(record.expectedSceneRevision) + 1);
    const outcome = { cleared: false };
    const result = await this.#options.session.enqueue({
      kind: "lifecycle",
      retainedBytes: 0,
      run: ({ publish, snapshot }) => {
        const base = {
          ...record.sidecarBase,
          rawTextSha256: null,
          revision: null,
        };
        if (
          !this.#options.history.replaceAfterExternalReload(scene, {
            base,
            sourceDigest: state.sourceDigest,
            sourceGeneration: state.sourceGeneration,
          })
        )
          return;
        this.#options.onRemoved(base);
        this.#clearIssueStatus();
        outcome.cleared = true;
        publish({ ...snapshot, persistence: { kind: "unannotated" }, scene });
      },
    });
    return result.kind === "completed" && outcome.cleared
      ? commandSuccess(undefined)
      : commandFailure("sidecar-drift");
  }

  async #publishConflict(
    retry: "reload" | null = null,
  ): Promise<CommandResultV1<void>> {
    return this.#publishIssue(
      "conflict",
      Object.freeze({ kind: "sidecar-changed" }),
      Object.freeze({ kind: "none" }),
      retry,
    );
  }

  async #publishDrift(
    driftKind: Exclude<DriftStatusV1["kind"], "none">,
    retry: "marker" | null = null,
  ): Promise<CommandResultV1<void>> {
    return this.#publishIssue(
      "drift",
      Object.freeze({ kind: "none" }),
      Object.freeze({ kind: driftKind }),
      retry,
    );
  }

  async #publishIssue(
    kind: "conflict" | "drift",
    conflict: ConflictStatusV1,
    drift: DriftStatusV1,
    retry: "marker" | "reload" | null,
  ): Promise<CommandResultV1<void>> {
    this.#issueStatus = Object.freeze({
      conflict,
      drift,
      retry:
        retry === null
          ? Object.freeze({ kind: "not-required" })
          : this.#nextRetry(retry),
    });
    const result = await this.#options.session.enqueue({
      kind: "persistence",
      retainedBytes: 0,
      run: ({ publish, snapshot }) =>
        publish({ ...snapshot, persistence: { kind } }),
    });
    return result.kind === "completed"
      ? commandSuccess(undefined)
      : commandFailure("resource-limit");
  }

  async #publishReload(
    reload: RuntimeExternalReloadV1,
  ): Promise<CommandResultV1<void>> {
    const state = this.#options.readState();
    if (
      reload.sidecar.noteIdentity.markdownContentDigest !==
        state?.sourceDigest ||
      reload.sidecar.noteIdentity.sourceGeneration !== state.sourceGeneration
    ) {
      return commandFailure("sidecar-conflict");
    }
    let scene: RuntimeSceneStateV1;
    try {
      scene = validateSerializedSceneStateV1(reload.sidecar.scene);
    } catch {
      return commandFailure("sidecar-conflict");
    }
    const replayed = replayMaterializedRecoveryHistory({
      hostEffectsMayBeReachable: true,
      noteIdentity: state.identity,
      replay: [],
      sidecarRootScene: scene,
    });
    if (!replayed.ok) return commandFailure("sidecar-conflict");
    const revision = reload.base.revision;
    if (revision === null) return commandFailure("sidecar-conflict");
    const outcome = { applied: false };
    const published = await this.#options.session.enqueue({
      kind: "lifecycle",
      retainedBytes: 0,
      run: ({ publish, snapshot }) => {
        if (
          !this.#options.history.replaceAfterExternalReload(scene, {
            base: reload.base,
            restoreSnapshot: replayed.value,
            sourceDigest: state.sourceDigest,
            sourceGeneration: state.sourceGeneration,
          })
        )
          return;
        this.#options.onReload(reload, scene);
        this.#clearIssueStatus();
        outcome.applied = true;
        publish({
          ...snapshot,
          persistence: {
            kind: "clean",
            sidecarRevision: revision,
          },
          scene,
        });
      },
    });
    if (published.kind !== "completed") return commandFailure("resource-limit");
    return outcome.applied
      ? commandSuccess(undefined)
      : commandFailure("sidecar-conflict");
  }

  #prepareLocalCopy(): Promise<CommandResultV1<PreparedSidecarWrite>> {
    const state = this.#options.readState();
    if (state === null || state.pendingRecovery || state.rawText === null) {
      return Promise.resolve(commandFailure("sidecar-conflict"));
    }
    return Promise.resolve(
      commandSuccess({
        rawText: state.rawText,
        utf8Bytes: new TextEncoder().encode(state.rawText).byteLength,
      }),
    );
  }

  #nextRetry(action: RuntimeRetryActionV1): RetryStatusV1 {
    this.#retryAttempts =
      this.#retryAction === action ? this.#retryAttempts + 1 : 1;
    this.#retryAction = action;
    return Object.freeze({
      action,
      attemptCount: this.#retryAttempts,
      kind: "available",
    });
  }

  #recordRetry(action: RuntimeRetryActionV1): void {
    this.#issueStatus = Object.freeze({
      ...this.#issueStatus,
      retry: this.#nextRetry(action),
    });
  }

  #clearIssueStatus(): void {
    this.#issueStatus = CLEAR_ISSUE_STATUS;
    this.#retryAction = null;
    this.#retryAttempts = 0;
  }

  #clearCompletedRemovalIssue(): void {
    if (this.#removal?.hasActiveRemoval !== true) this.#clearIssueStatus();
  }
}

function emptyScene(revision: number): RuntimeSceneStateV1 {
  return createRuntimeSceneStateV1({
    elements: [],
    groups: [],
    noteAppearance: {
      background: "none",
      contrast: "low",
      horizontalSpacing: "standard",
    },
    objectOrder: [],
    revision: createSceneRevision(revision),
  });
}

export function createRuntimePersistenceExternalV1(
  options: RuntimePersistenceExternalOptionsV1,
): RuntimePersistenceExternalV1 {
  const owner = new RuntimePersistenceExternalV1(options);
  return owner;
}
