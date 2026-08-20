import { validateSerializedSceneStateV1 } from "../../domain/codecs";
import type { RuntimeSceneStateV1 } from "../../domain/scene";
import {
  replayMaterializedRecoveryHistory,
  type HostHistorySnapshotV1,
} from "../../application/host-history";
import {
  createSidecarRevision,
  createSaveGeneration,
  createSourceGeneration,
  type NoteIdentityV1,
  type NoteSessionSnapshotV1,
  type Sha256Digest,
  type SourceCheckpointId,
  type SourceGeneration,
} from "../../application/note-session";
import type {
  ActiveRemovalRecoveryV1,
  RecoverySnapshotV1,
  RecoveryStore,
  SidecarBaseIdentityV1,
} from "../../application/recovery";
import {
  createSourceSnapshot,
  createStreamingSha256PortV1,
  digestMarkdownSnapshot,
  materializeAnnotationPatchThroughOffsetMapV1,
  materializeRecoveryHistory,
} from "../../application/source-coordination";
import type { SourceDigestWorkPortV1 } from "../../application/source-coordination/work-ports";
import {
  type PersistenceCodecPortV1,
  type SaveStartClockV1,
  type SidecarStorageLayoutV1,
} from "../../application/persistence";
import type { SidecarMarkerWriter } from "./vault-sidecar/marker";
import type { VaultFileCapability } from "./vault-sidecar/paths";
import { deriveSidecarPath } from "./vault-sidecar/paths";
import type { VaultSidecarRepository } from "./vault-sidecar/repository";
import { repairRelocatedSidecarV1 } from "./runtime-persistence-repair";
import {
  loadRuntimeSidecarV1,
  type RuntimeSidecarLoadResultV1,
} from "./runtime-sidecar-load";
import {
  runtimeRemovalMatchesBaseV1,
  runtimeRemovalSourceEvidenceV1,
} from "./runtime-removal";
import type { RuntimeSidecarResolutionV1 } from "./runtime-sidecar-resolution";
import { materializeRuntimeSidecarResolutionV1 } from "./runtime-sidecar-resolution";
export {
  resolveRuntimeRelocatedSidecarV1,
  resolveRuntimeSidecarMarkerV1,
} from "./runtime-sidecar-resolution";
export type {
  RuntimeRelocatedSidecarEvidenceV1,
  RuntimeSidecarResolutionV1,
} from "./runtime-sidecar-resolution";

export interface RuntimePersistenceOpenOptionsV1 {
  readonly identity: NoteIdentityV1;
  readonly initialMarkdown: string;
  readonly persistenceCodecPort: PersistenceCodecPortV1;
  readonly recovery: RecoveryStore;
  readonly resolution: RuntimeSidecarResolutionV1;
  readonly sourceDigestWorkPort: SourceDigestWorkPortV1;
  readonly resolveMarkdownFile: (path: string) => VaultFileCapability | null;
  readonly settingsRevision: import("../../application/note-session").SettingsRevision;
  readonly vault: { readonly normalizePath: (path: string) => string };
  readonly writableTier: import("../../application/persistence").SidecarWritableTierV1;
}

export type RuntimePersistenceOpenResultV1 =
  | { readonly kind: "conflict" | "drift" | "newer-version" }
  | {
      readonly activeRemoval: ActiveRemovalRecoveryV1;
      readonly base: SidecarBaseIdentityV1;
      readonly digest: Sha256Digest;
      readonly generation: SourceGeneration;
      readonly kind: "removal-pending";
    }
  | {
      readonly base: SidecarBaseIdentityV1;
      readonly digest: Sha256Digest;
      readonly generation: SourceGeneration;
      readonly kind: "unannotated";
    }
  | {
      readonly activeRemoval?: ActiveRemovalRecoveryV1;
      readonly base: SidecarBaseIdentityV1;
      readonly digest: Sha256Digest;
      readonly file: VaultFileCapability;
      readonly generation: SourceGeneration;
      readonly historySnapshot: HostHistorySnapshotV1;
      readonly kind: "existing";
      readonly layout: SidecarStorageLayoutV1;
      readonly rawText: string;
      readonly recoveredAttemptIds: readonly import("../../application/note-session").RecoveryAttemptId[];
      readonly recoveredCheckpointIds: readonly SourceCheckpointId[];
      readonly revision: NonNullable<SidecarBaseIdentityV1["revision"]>;
      readonly scene: RuntimeSceneStateV1;
    };

export async function openRuntimePersistenceV1(
  provided: RuntimePersistenceOpenOptionsV1,
  repository: VaultSidecarRepository,
  marker: SidecarMarkerWriter,
): Promise<RuntimePersistenceOpenResultV1> {
  const materialized = await materializeRuntimeSidecarResolutionV1({
    identity: provided.identity,
    marker,
    normalizePath: provided.vault.normalizePath,
    noteFile: provided.resolveMarkdownFile(
      provided.identity.vaultRelativeMarkdownPath,
    ),
    persistenceCodecPort: provided.persistenceCodecPort,
    repository,
    resolution: provided.resolution,
  });
  if (materialized.kind !== "resolved") return materialized;
  const options = {
    ...provided,
    resolution: materialized.resolution,
  } as const;
  const digest = await digestRuntimeTextV1(
    options.initialMarkdown,
    options.sourceDigestWorkPort,
  );
  if (digest === null || options.resolution.kind === "blocked") {
    return { kind: "conflict" };
  }
  const active = await options.recovery.loadActiveRemoval({
    noteIdentity: options.identity,
  });
  if (!active.ok) return { kind: "drift" };
  if (active.value !== null && options.resolution.kind === "unannotated")
    return openPendingRemoval(active.value, digest);
  if (options.resolution.kind === "unannotated") {
    return openUnannotated(options, digest);
  }
  let loaded = await loadRuntimeSidecarV1(
    repository,
    options.resolution.sidecarPath,
    options.persistenceCodecPort,
  );
  if (loaded.kind === "read-only-newer-version") {
    return { kind: "newer-version" };
  }
  if (loaded.kind !== "current")
    return active.value === null
      ? { kind: "conflict" }
      : openPendingRemoval(active.value, digest);
  if (options.resolution.relocation !== undefined) {
    const repaired = await repairRelocatedSidecarV1({
      digestText: (value) =>
        digestRuntimeTextV1(value, options.sourceDigestWorkPort),
      evidence: options.resolution.relocation,
      loaded,
      markdownDigest: digest,
      marker,
      open: options,
      repository,
    });
    if (repaired === null) return { kind: "drift" };
    loaded = repaired;
  }
  return finishExistingOpen(options, loaded, digest, active.value);
}

async function finishExistingOpen(
  options: RuntimePersistenceOpenOptionsV1,
  loaded: Extract<RuntimeSidecarLoadResultV1, { readonly kind: "current" }>,
  digest: Sha256Digest,
  activeRemoval: ActiveRemovalRecoveryV1 | null,
): Promise<RuntimePersistenceOpenResultV1> {
  const sidecar = loaded.sidecar;
  if (
    sidecar.noteIdentity.vaultRelativeMarkdownPath !==
      options.identity.vaultRelativeMarkdownPath ||
    deriveSidecarPath(
      options.identity.vaultRelativeMarkdownPath,
      sidecar.storageLayout,
      options.vault.normalizePath,
    ) !== loaded.file.path
  )
    return { kind: "drift" };
  const rawDigest = await digestRuntimeTextV1(
    loaded.rawText,
    options.sourceDigestWorkPort,
  );
  if (rawDigest === null) return { kind: "conflict" };
  const revision = createSidecarRevision(sidecar.revision);
  const base = baseIdentity(
    options.identity,
    loaded.file.path,
    revision,
    rawDigest,
  );
  if (
    activeRemoval !== null &&
    !runtimeRemovalMatchesBaseV1(
      activeRemoval,
      options.identity,
      base,
      sidecar.scene.revision,
    )
  )
    return { kind: "drift" };
  const recovery =
    activeRemoval === null
      ? await options.recovery.loadNote({
          kind: "existing-sidecar",
          noteIdentity: options.identity,
          base,
          validatedSidecarSourceGeneration:
            sidecar.noteIdentity.sourceGeneration,
          validatedSidecarSourceDigest:
            sidecar.noteIdentity.markdownContentDigest,
          currentMarkdownDigest: digest,
          currentMarkdownUtf16Length: options.initialMarkdown.length,
        })
      : commandRecovery(activeRemoval);
  if (!recovery.ok || recovery.value.relocations.length > 0)
    return { kind: "drift" };
  const scene = validateSerializedSceneStateV1(sidecar.scene);
  const history = replayRuntimeRecovery({
    base,
    currentDigest: digest,
    generation: sidecar.noteIdentity.sourceGeneration,
    options,
    recovery: recovery.value,
    scene,
    sidecarDigest: sidecar.noteIdentity.markdownContentDigest,
  });
  if (history === null) return { kind: "drift" };
  const finalCheckpoint = recovery.value.checkpoints.at(Number("-1"));
  return Object.freeze({
    ...(activeRemoval === null ? {} : { activeRemoval }),
    base,
    digest,
    file: loaded.file,
    generation:
      finalCheckpoint?.replacementGeneration ??
      sidecar.noteIdentity.sourceGeneration,
    historySnapshot: history,
    kind: "existing",
    layout: sidecar.storageLayout,
    rawText: loaded.rawText,
    recoveredAttemptIds: recovery.value.attempts.map(
      (attempt) => attempt.attemptId,
    ),
    recoveredCheckpointIds: recovery.value.checkpoints.map(
      (checkpoint) => checkpoint.checkpointId,
    ),
    revision,
    scene: history.scene,
  });
}

function openPendingRemoval(
  activeRemoval: ActiveRemovalRecoveryV1,
  digest: Sha256Digest,
): RuntimePersistenceOpenResultV1 {
  const source = runtimeRemovalSourceEvidenceV1(activeRemoval, digest);
  return source === null
    ? { kind: "drift" }
    : Object.freeze({
        activeRemoval,
        base: activeRemoval.removal.sidecarBase,
        digest: source.digest,
        generation: source.generation,
        kind: "removal-pending",
      });
}

function commandRecovery(
  bundle: ActiveRemovalRecoveryV1,
): import("../../application/note-session").CommandResultV1<RecoverySnapshotV1> {
  return {
    ok: true,
    value: {
      attempts: bundle.attempts,
      checkpoints: bundle.checkpoints,
      relocations: [],
      removals: [bundle.removal],
    },
  };
}

export async function digestRuntimeTextV1(
  value: string,
  workPort?: SourceDigestWorkPortV1,
): Promise<Sha256Digest | null> {
  const snapshot = createSourceSnapshot(value);
  if (!snapshot.ok) return null;
  const digest = await digestMarkdownSnapshot(
    createStreamingSha256PortV1(),
    snapshot.value,
    workPort,
  );
  return digest.ok ? digest.value : null;
}

export function runtimeOpenSnapshotV1(
  snapshot: NoteSessionSnapshotV1,
  opened: RuntimePersistenceOpenResultV1,
): NoteSessionSnapshotV1 {
  if (opened.kind === "removal-pending") {
    return {
      ...snapshot,
      lifecycle: "ready",
      persistence: { kind: "drift" },
      source: {
        digest: opened.digest,
        generation: opened.generation,
        kind: "durable",
      },
    };
  }
  if (opened.kind !== "existing" && opened.kind !== "unannotated") {
    return {
      ...snapshot,
      lifecycle: "ready",
      persistence: { kind: opened.kind },
    };
  }
  const source = {
    digest: opened.digest,
    generation: opened.generation,
    kind: "durable" as const,
  };
  if (opened.kind === "unannotated") {
    return {
      ...snapshot,
      lifecycle: "ready",
      persistence: { kind: opened.kind },
      source,
    };
  }
  let persistence: NoteSessionSnapshotV1["persistence"] = {
    kind: "saving",
    generation: createSaveGeneration(1),
  };
  if (
    opened.recoveredAttemptIds.length === 0 &&
    opened.recoveredCheckpointIds.length === 0
  )
    persistence = { kind: "clean", sidecarRevision: opened.revision };
  if (opened.activeRemoval !== undefined) persistence = { kind: "drift" };
  return {
    ...snapshot,
    lifecycle: "ready",
    persistence,
    scene: opened.scene,
    source,
  };
}

async function openUnannotated(
  options: RuntimePersistenceOpenOptionsV1,
  digest: Sha256Digest,
): Promise<RuntimePersistenceOpenResultV1> {
  if (options.resolution.kind !== "unannotated") return { kind: "conflict" };
  const generation = createSourceGeneration(1);
  const base = baseIdentity(
    options.identity,
    options.resolution.sidecarPath,
    null,
    null,
  );
  const recovery = await options.recovery.loadNote({
    kind: "absent-first-sidecar",
    noteIdentity: options.identity,
    base,
    expectedVaultRelativePath: options.resolution.sidecarPath,
    currentMarkdownDigest: digest,
    currentMarkdownUtf16Length: options.initialMarkdown.length,
  });
  return recovery.ok && recoveryIsEmpty(recovery.value)
    ? Object.freeze({ base, digest, generation, kind: "unannotated" })
    : { kind: "drift" };
}

function baseIdentity(
  identity: NoteIdentityV1,
  sidecarPath: string,
  revision: SidecarBaseIdentityV1["revision"],
  rawTextSha256: SidecarBaseIdentityV1["rawTextSha256"],
): SidecarBaseIdentityV1 {
  return Object.freeze({
    markdownPath: identity.vaultRelativeMarkdownPath,
    rawTextSha256,
    revision,
    vaultRelativePath: sidecarPath,
  });
}

function recoveryIsEmpty(snapshot: RecoverySnapshotV1): boolean {
  return (
    snapshot.attempts.length === 0 &&
    snapshot.checkpoints.length === 0 &&
    snapshot.relocations.length === 0 &&
    snapshot.removals.length === 0
  );
}

function replayRuntimeRecovery(input: {
  readonly base: SidecarBaseIdentityV1;
  readonly currentDigest: Sha256Digest;
  readonly generation: SourceGeneration;
  readonly options: RuntimePersistenceOpenOptionsV1;
  readonly recovery: RecoverySnapshotV1;
  readonly scene: RuntimeSceneStateV1;
  readonly sidecarDigest: Sha256Digest;
}): HostHistorySnapshotV1 | null {
  const {
    base,
    currentDigest,
    generation,
    options,
    recovery,
    scene,
    sidecarDigest,
  } = input;
  const rootLength =
    recovery.checkpoints[0]?.priorUtf16Length ?? options.initialMarkdown.length;
  const materialized = materializeRecoveryHistory({
    attempts: recovery.attempts,
    checkpoints: recovery.checkpoints,
    materializePatch: materializeAnnotationPatchThroughOffsetMapV1,
    root: { base, digest: sidecarDigest, generation, utf16Length: rootLength },
    target: {
      digest: currentDigest,
      utf16Length: options.initialMarkdown.length,
    },
  });
  if (!materialized.ok) return null;
  const replayed = replayMaterializedRecoveryHistory({
    hostEffectsMayBeReachable: true,
    noteIdentity: options.identity,
    replay: materialized.value,
    sidecarRootScene: scene,
  });
  return replayed.ok ? replayed.value : null;
}

export function runtimeCheckpointSchedulerV1(): import("../../application/source-coordination/checkpoints").SourceCheckpointSchedulerV1 {
  return {
    cancel: (handle): void => globalThis.clearTimeout(handle as number),
    now: (): number => Date.now(),
    schedule: (delayMs, callback): number =>
      globalThis.setTimeout(callback, delayMs) as unknown as number,
  };
}

export function runtimeSaveClockV1(): SaveStartClockV1 {
  return {
    cancel: (handle: unknown): void =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    nowEpochMs: (): number => Date.now(),
    schedule: (callback: () => void, delayMs: number): unknown =>
      globalThis.setTimeout(callback, delayMs),
  };
}
