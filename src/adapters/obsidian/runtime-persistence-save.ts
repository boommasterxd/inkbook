import { serializeRuntimeSceneStateV1 } from "../../domain/codecs";
import type {
  NoteIdentityV1,
  NoteSessionSnapshotV1,
  NoteSessionV1,
  RecoveryAttemptId,
  SaveGeneration,
  Sha256Digest,
  SourceCheckpointId,
  SourceGeneration,
} from "../../application/note-session";
import {
  SavePipeline,
  createPersistenceEncodeWorkV1,
  PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1,
  SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1,
  type InkbookSidecarV1,
  type PersistencePermitPool,
  type PersistenceCodecPortV1,
  type SaveCaptureV1,
  type SavePipelinePortsV1,
  type SavePipelineResultV1,
  SaveStartScheduler,
  type SaveStartScheduleResultV1,
  type SidecarStorageLayoutV1,
  type SidecarWritableTierV1,
} from "../../application/persistence";
import type {
  RecoveryStore,
  SidecarBaseIdentityV1,
} from "../../application/recovery";
import type { SourceDigestWorkPortV1 } from "../../application/source-coordination/work-ports";
import {
  digestRuntimeTextV1,
  runtimeSaveClockV1,
} from "./runtime-persistence-open";
import type { VaultFileCapability } from "./vault-sidecar/paths";
import {
  type PreparedSidecarWrite,
  type VaultSidecarRepository,
} from "./vault-sidecar/repository";

type RuntimeSavePortsV1 = SavePipelinePortsV1<
  NoteSessionSnapshotV1,
  PreparedSidecarWrite
>;
type RuntimeSaveRequestV1 = Parameters<
  SavePipeline<NoteSessionSnapshotV1, PreparedSidecarWrite>["enqueue"]
>[0];

export function requireRuntimeSidecarBaseV1(
  base: SidecarBaseIdentityV1 | null,
): SidecarBaseIdentityV1 {
  if (base === null) throw new Error("Sidecar base unavailable.");
  return base;
}

export interface RuntimeSavePipelineOptionsV1 {
  readonly base: SidecarBaseIdentityV1;
  readonly identity: NoteIdentityV1;
  readonly layout: SidecarStorageLayoutV1;
  readonly onAcknowledged: (
    base: SidecarBaseIdentityV1,
    rawText: string,
    generation: SourceGeneration,
    digest: Sha256Digest,
  ) => void;
  readonly onWritePrepared: (base: SidecarBaseIdentityV1) => void;
  readonly onWriteRejected: (base: SidecarBaseIdentityV1) => void;
  readonly permits: PersistencePermitPool;
  readonly persistenceCodecPort: PersistenceCodecPortV1;
  readonly readFile: () => VaultFileCapability | null;
  readonly readRawText: () => string | null;
  readonly recovery: RecoveryStore;
  readonly repository: VaultSidecarRepository;
  readonly sourceDigestWorkPort: SourceDigestWorkPortV1;
  readonly writableTier: SidecarWritableTierV1;
}

function createRuntimeSavePipelineV1(
  options: RuntimeSavePipelineOptionsV1,
): SavePipeline<NoteSessionSnapshotV1, PreparedSidecarWrite> {
  let writtenRawText: string | null = null;
  const ports: RuntimeSavePortsV1 = {
    acknowledgeRecovery: async (request) => {
      const acknowledged = await options.recovery.acknowledgeSidecar(request);
      if (acknowledged.ok && writtenRawText !== null) {
        options.onAcknowledged(
          request.acknowledgedReplacementBase,
          writtenRawText,
          request.sourceGeneration,
          request.sourceDigest,
        );
        writtenRawText = null;
      }
      return acknowledged;
    },
    encode: (request) =>
      encodeRuntimeSidecar(
        options,
        request.capture,
        request.revision,
        request.baseRevision,
        request.savedAtEpochMs,
        request.signal,
      ),
    nowEpochMs: (): number => Date.now(),
    prepareVaultWrite: async (request) => {
      const file = options.readFile();
      const rawText = options.readRawText();
      if (file === null || rawText === null) return { kind: "conflict" };
      options.onWritePrepared(request.acknowledgedReplacementBase);
      const result = await options.repository.compareAndProcess(
        file,
        rawText,
        request.payload,
        request.signal,
      );
      if (
        result.kind === "collision" ||
        result.kind === "conflict" ||
        result.kind === "stale-acknowledgement" ||
        result.kind === "wrong-file-kind"
      ) {
        options.onWriteRejected(request.acknowledgedReplacementBase);
        return { kind: "conflict" };
      }
      if (result.kind === "cancelled") return { kind: "cancelled" };
      if (result.kind !== "acknowledged") {
        options.onWriteRejected(request.acknowledgedReplacementBase);
        return { kind: "failed" };
      }
      writtenRawText = result.rawText;
      return { kind: "written" };
    },
  };
  return new SavePipeline(
    options.identity,
    options.base,
    options.permits,
    ports,
  );
}

function createRuntimeSaveBindingV1(
  options: RuntimeSavePipelineOptionsV1 & {
    readonly readFlushing: () => boolean;
    readonly readSession: () => NoteSessionV1 | null;
    readonly retainForRetry: (request: RuntimeSaveRequestV1) => void;
    readonly setFlushSave: (save: Promise<SavePipelineResultV1>) => void;
  },
): {
  readonly pipeline: SavePipeline<NoteSessionSnapshotV1, PreparedSidecarWrite>;
  readonly scheduler: SaveStartScheduler<NoteSessionSnapshotV1>;
} {
  const pipeline = createRuntimeSavePipelineV1(options);
  const scheduler = new SaveStartScheduler<NoteSessionSnapshotV1>(
    runtimeSaveClockV1(),
    (request) => {
      const session = options.readSession();
      if (session === null) return;
      enqueueRuntimeSaveV1({
        flushing: options.readFlushing(),
        pipeline,
        request,
        retainForRetry: options.retainForRetry,
        session,
        setFlushSave: options.setFlushSave,
      });
    },
  );
  return Object.freeze({ pipeline, scheduler });
}

function createRuntimePersistenceSaveBindingV1(input: {
  readonly base: SidecarBaseIdentityV1;
  readonly config: import("./runtime-session").RuntimePersistenceConfigV1;
  readonly identity: NoteIdentityV1;
  readonly layout: SidecarStorageLayoutV1;
  readonly onAcknowledged: RuntimeSavePipelineOptionsV1["onAcknowledged"];
  readonly onWritePrepared: RuntimeSavePipelineOptionsV1["onWritePrepared"];
  readonly onWriteRejected: RuntimeSavePipelineOptionsV1["onWriteRejected"];
  readonly readFile: () => VaultFileCapability | null;
  readonly readFlushing: () => boolean;
  readonly readRawText: () => string | null;
  readonly readSession: () => NoteSessionV1 | null;
  readonly repository: VaultSidecarRepository;
  readonly retainForRetry: (request: RuntimeSaveRequestV1) => void;
  readonly setFlushSave: (save: Promise<SavePipelineResultV1>) => void;
}): {
  readonly pipeline: SavePipeline<NoteSessionSnapshotV1, PreparedSidecarWrite>;
  readonly scheduler: SaveStartScheduler<NoteSessionSnapshotV1>;
} {
  return createRuntimeSaveBindingV1({
    base: input.base,
    identity: input.identity,
    layout: input.layout,
    onAcknowledged: input.onAcknowledged,
    onWritePrepared: input.onWritePrepared,
    onWriteRejected: input.onWriteRejected,
    permits: input.config.permits,
    persistenceCodecPort: input.config.persistenceCodecPort,
    readFile: input.readFile,
    readFlushing: input.readFlushing,
    readRawText: input.readRawText,
    readSession: input.readSession,
    recovery: input.config.recovery,
    repository: input.repository,
    retainForRetry: input.retainForRetry,
    setFlushSave: input.setFlushSave,
    sourceDigestWorkPort: input.config.sourceDigestWorkPort,
    writableTier: input.config.writableTier,
  });
}

export class RuntimePersistenceSaveControllerV1 {
  readonly #config: import("./runtime-session").RuntimePersistenceConfigV1;
  readonly #repository: VaultSidecarRepository;
  readonly #readFile: () => VaultFileCapability | null;
  readonly #readFlushing: () => boolean;
  readonly #readRawText: () => string | null;
  readonly #readSession: () => NoteSessionV1 | null;
  readonly #onAcknowledged: RuntimeSavePipelineOptionsV1["onAcknowledged"];
  readonly #onWritePrepared: RuntimeSavePipelineOptionsV1["onWritePrepared"];
  readonly #onWriteRejected: RuntimeSavePipelineOptionsV1["onWriteRejected"];
  readonly #retainForRetry: (request: RuntimeSaveRequestV1) => void;
  readonly #setFlushSave: (save: Promise<SavePipelineResultV1>) => void;

  public constructor(options: {
    readonly config: import("./runtime-session").RuntimePersistenceConfigV1;
    readonly repository: VaultSidecarRepository;
    readonly readFile: () => VaultFileCapability | null;
    readonly readFlushing: () => boolean;
    readonly readRawText: () => string | null;
    readonly readSession: () => NoteSessionV1 | null;
    readonly onAcknowledged: RuntimeSavePipelineOptionsV1["onAcknowledged"];
    readonly onWritePrepared: RuntimeSavePipelineOptionsV1["onWritePrepared"];
    readonly onWriteRejected: RuntimeSavePipelineOptionsV1["onWriteRejected"];
    readonly retainForRetry: (request: RuntimeSaveRequestV1) => void;
    readonly setFlushSave: (save: Promise<SavePipelineResultV1>) => void;
  }) {
    this.#config = options.config;
    this.#repository = options.repository;
    this.#readFile = options.readFile;
    this.#readFlushing = options.readFlushing;
    this.#readRawText = options.readRawText;
    this.#readSession = options.readSession;
    this.#onAcknowledged = options.onAcknowledged;
    this.#onWritePrepared = options.onWritePrepared;
    this.#onWriteRejected = options.onWriteRejected;
    this.#retainForRetry = options.retainForRetry;
    this.#setFlushSave = options.setFlushSave;
  }

  public bind(
    base: SidecarBaseIdentityV1,
    identity: NoteIdentityV1,
    layout: SidecarStorageLayoutV1,
  ): {
    readonly pipeline: SavePipeline<
      NoteSessionSnapshotV1,
      PreparedSidecarWrite
    >;
    readonly scheduler: SaveStartScheduler<NoteSessionSnapshotV1>;
  } {
    return createRuntimePersistenceSaveBindingV1({
      base,
      config: this.#config,
      identity,
      layout,
      onAcknowledged: this.#onAcknowledged,
      onWritePrepared: this.#onWritePrepared,
      onWriteRejected: this.#onWriteRejected,
      readFile: this.#readFile,
      readFlushing: this.#readFlushing,
      readRawText: this.#readRawText,
      readSession: this.#readSession,
      repository: this.#repository,
      retainForRetry: this.#retainForRetry,
      setFlushSave: this.#setFlushSave,
    });
  }
}

export function enqueueRuntimeSaveV1(options: {
  readonly flushing: boolean;
  readonly pipeline: SavePipeline<NoteSessionSnapshotV1, PreparedSidecarWrite>;
  readonly request: RuntimeSaveRequestV1;
  readonly session: NoteSessionV1;
  readonly setFlushSave: (save: Promise<SavePipelineResultV1>) => void;
  readonly retainForRetry?: (request: RuntimeSaveRequestV1) => void;
}): void {
  if (options.flushing) {
    const save = options.pipeline.enqueue(options.request);
    options.setFlushSave(save);
    void save.then((result) => {
      if (result.kind === "failed") {
        options.retainForRetry?.(options.request);
      }
    });
    return;
  }
  void options.session.enqueue({
    kind: "save",
    replacement: {
      key: "runtime-sidecar-save",
      revision: options.request.generation,
    },
    retainedBytes: 0,
    run: async ({ publish, snapshot }) => {
      publish({
        ...snapshot,
        persistence: {
          generation: options.request.generation,
          kind: "saving",
        },
      });
      const save = options.pipeline.enqueue(options.request);
      options.setFlushSave(save);
      const result = await save;
      const revision = options.pipeline.snapshot.currentBase.revision;
      if (result.kind === "acknowledged" && revision !== null) {
        publish({
          ...snapshot,
          persistence: { kind: "clean", sidecarRevision: revision },
        });
      } else if (
        result.kind === "conflict" ||
        result.kind === "recovery-conflict"
      ) {
        publish({ ...snapshot, persistence: { kind: "conflict" } });
      } else if (result.kind === "failed") {
        options.retainForRetry?.(options.request);
        publish({
          ...snapshot,
          persistence: {
            generation: options.request.generation,
            kind: "dirty",
          },
        });
      }
    },
  });
}

export function markRuntimeSaveDirtyV1(options: {
  readonly generation: SaveGeneration;
  readonly pendingAttempts: Set<RecoveryAttemptId>;
  readonly pendingCheckpoints: Set<SourceCheckpointId>;
  readonly scheduler: import("../../application/persistence").SaveStartScheduler<NoteSessionSnapshotV1>;
  readonly session: NoteSessionV1;
  readonly source: Readonly<{
    digest: Sha256Digest;
    generation: SourceGeneration;
  }>;
}): SaveStartScheduleResultV1 {
  const coveredAttemptIds = [...options.pendingAttempts];
  const coveredCheckpointIds = [...options.pendingCheckpoints];
  options.pendingAttempts.clear();
  options.pendingCheckpoints.clear();
  const result = options.scheduler.markDirty({
    generation: options.generation,
    coveredAttemptIds,
    coveredCheckpointIds,
    capture: () => ({
      sceneRevision: options.session.snapshot.scene.revision,
      snapshot: options.session.snapshot,
      sourceDigest: options.source.digest,
      sourceGeneration: options.source.generation,
    }),
  });
  if (result === "disposed" || result === "rejected") {
    for (const id of coveredAttemptIds) options.pendingAttempts.add(id);
    for (const id of coveredCheckpointIds) options.pendingCheckpoints.add(id);
  }
  return result;
}

export function markRuntimePersistenceDirtyV1(options: {
  readonly createGeneration: () => SaveGeneration;
  readonly pendingAttempts: Set<RecoveryAttemptId>;
  readonly pendingCheckpoints: Set<SourceCheckpointId>;
  readonly scheduler: import("../../application/persistence").SaveStartScheduler<NoteSessionSnapshotV1>;
  readonly session: NoteSessionV1;
  readonly source: Readonly<{
    readonly digest: Sha256Digest;
    readonly generation: SourceGeneration;
  }>;
  readonly onScheduled: () => void;
}): void {
  const result = markRuntimeSaveDirtyV1({
    generation: options.createGeneration(),
    pendingAttempts: options.pendingAttempts,
    pendingCheckpoints: options.pendingCheckpoints,
    scheduler: options.scheduler,
    session: options.session,
    source: options.source,
  });
  if (result === "scheduled" || result === "replaced") options.onScheduled();
}

async function encodeRuntimeSidecar(
  options: RuntimeSavePipelineOptionsV1,
  capture: SaveCaptureV1<NoteSessionSnapshotV1>,
  revision: number,
  baseRevision: number | null,
  savedAtEpochMs: number,
  signal: AbortSignal,
): ReturnType<RuntimeSavePortsV1["encode"]> {
  const sidecar: InkbookSidecarV1 = {
    baseRevision,
    format: "inkbook-obsidian-annotations",
    noteIdentity: {
      markdownContentDigest: capture.sourceDigest,
      sourceGeneration: capture.sourceGeneration,
      vaultRelativeMarkdownPath: options.identity.vaultRelativeMarkdownPath,
    },
    revision,
    savedAtEpochMs,
    scene: serializeRuntimeSceneStateV1(capture.snapshot.scene),
    schemaVersion: { major: 1, minor: 0 },
    storageLayout: options.layout,
  };
  const submission = options.persistenceCodecPort.submit(
    createPersistenceEncodeWorkV1(
      sidecar,
      options.writableTier,
      PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1,
      SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1[options.writableTier],
    ),
  );
  const cancel = (): void => submission.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  const encoded = await submission.result.finally(() =>
    signal.removeEventListener("abort", cancel),
  );
  if (encoded.kind !== "encoded-sidecar" || signal.aborted) {
    throw new Error("Unable to encode sidecar.");
  }
  const payload: PreparedSidecarWrite = Object.freeze({
    rawText: new TextDecoder("utf-8", { fatal: true }).decode(encoded.bytes),
    utf8Bytes: encoded.bytes.byteLength,
  });
  const rawTextSha256 = await digestRuntimeTextV1(
    payload.rawText,
    options.sourceDigestWorkPort,
  );
  if (rawTextSha256 === null) {
    throw new Error("Unable to hash encoded sidecar.");
  }
  return { payload, rawTextSha256 };
}
