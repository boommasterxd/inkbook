import type {
  PrepareHostEffectRequestV1,
  PrepareHostEffectResultV1,
} from "../../application/host-history/types";
import {
  commandFailure,
  commandSuccess,
  createSidecarRevision,
  type CommandResultV1,
  type NoteIdentityV1,
  type NoteSessionSnapshotV1,
  type NoteSessionV1,
  type SettingsRevision,
} from "../../application/note-session";
import {
  canAdmitFirstSidecarCreation,
  createPersistenceEncodeWorkV1,
  FirstSidecarCoordinatorV1,
  PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1,
  SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1,
  type FirstSidecarCommandV1,
  type FirstSidecarCompletionResultV1,
  type FirstSidecarCreateRequestV1,
  type FirstSidecarCreateResultV1,
  type FirstSidecarDispatchPreparationV1,
  type FirstSidecarPortsV1,
  type FirstSidecarPrepareResultV1,
  type FirstSidecarRelocationGateV1,
  type FirstSidecarSourceEvidenceV1,
  type InkbookSidecarV1,
  type PersistenceCodecPortV1,
  type PersistencePermitPool,
  type SidecarStorageLayoutV1,
  type SidecarWritableTierV1,
  sidecarStoragePolicyToLayout,
} from "../../application/persistence";
import type {
  HostRecordedForwardAttemptV1,
  RecoveryStore,
} from "../../application/recovery";
import type { SourceDigestWorkPortV1 } from "../../application/source-coordination/work-ports";
import { digestRuntimeTextV1 } from "./runtime-persistence-open";
import type { VaultFileCapability } from "./vault-sidecar/paths";
import type { SidecarMarkerWriter } from "./vault-sidecar/marker";
import type { VaultSidecarRepository } from "./vault-sidecar/repository";
import type { RuntimePersistenceConfigV1 } from "./runtime-session";
import { loadRuntimeSidecarV1 } from "./runtime-sidecar-load";

interface RuntimeFirstSidecarContextV1 {
  readonly expectedSettingsRevision: SettingsRevision;
  readonly expectedVaultRelativePath: string;
  readonly noteIdentity: NoteIdentityV1;
  readonly storageLayout: SidecarStorageLayoutV1;
}

export interface RuntimeFirstSidecarOptionsV1<TDispatch> {
  readonly acknowledgeRecovery: Pick<RecoveryStore, "acknowledgeSidecar">;
  readonly awaitObservedMarkerCheckpoint: (
    signal: AbortSignal,
    correlation: RuntimeMarkerCheckpointCorrelationV1,
  ) => Promise<FirstSidecarSourceEvidenceV1 | null>;
  readonly marker: SidecarMarkerWriter;
  readonly nowEpochMs: () => number;
  readonly permits: PersistencePermitPool;
  readonly persistenceCodecPort: PersistenceCodecPortV1;
  readonly prepareDispatch: (
    request: PrepareHostEffectRequestV1,
    evidence: FirstSidecarSourceEvidenceV1,
    signal: AbortSignal,
  ) => Promise<FirstSidecarDispatchPreparationV1<TDispatch>>;
  readonly readContext: () => RuntimeFirstSidecarContextV1;
  readonly readNoteFile: () => VaultFileCapability | null;
  readonly readRelocationGate: () => FirstSidecarRelocationGateV1;
  readonly repository: VaultSidecarRepository;
  readonly revalidateSource: (
    evidence: FirstSidecarSourceEvidenceV1,
    snapshot: NoteSessionSnapshotV1,
  ) => boolean;
  readonly session: NoteSessionV1;
  readonly sourceDigestWorkPort: SourceDigestWorkPortV1;
  readonly writableTier: SidecarWritableTierV1;
}

export interface RuntimeMarkerCheckpointCorrelationV1 {
  readonly command: FirstSidecarCommandV1;
  readonly priorSourceDigest: import("../../application/note-session").Sha256Digest;
  readonly priorSourceGeneration: import("../../application/note-session").SourceGeneration;
}

export interface RuntimeFirstSidecarAdoptionV1 {
  readonly base: import("../../application/recovery").SidecarBaseIdentityV1;
  readonly file: VaultFileCapability;
  readonly layout: SidecarStorageLayoutV1;
  readonly rawText: string;
}

export class RuntimeFirstSidecarV1<TDispatch> {
  readonly #coordinator: FirstSidecarCoordinatorV1<TDispatch>;
  readonly #options: RuntimeFirstSidecarOptionsV1<TDispatch>;
  #request: PrepareHostEffectRequestV1 | null = null;
  #markerCorrelation: RuntimeMarkerCheckpointCorrelationV1 | null = null;

  public constructor(options: RuntimeFirstSidecarOptionsV1<TDispatch>) {
    this.#options = options;
    this.#coordinator = new FirstSidecarCoordinatorV1(
      this.#createCoordinatorPorts(),
    );
  }

  public prepare(
    request: PrepareHostEffectRequestV1,
  ): Promise<FirstSidecarPrepareResultV1<TDispatch>> {
    if (this.#request !== null) {
      return Promise.resolve(Object.freeze({ kind: "rejected" }));
    }
    let context: RuntimeFirstSidecarContextV1;
    try {
      context = this.#options.readContext();
    } catch {
      return Promise.resolve(Object.freeze({ kind: "rejected" }));
    }
    const command: FirstSidecarCommandV1 = {
      expectedSettingsRevision: context.expectedSettingsRevision,
      expectedVaultRelativePath: context.expectedVaultRelativePath,
      historyEntryId: request.historyEntry.historyEntryId,
      noteIdentity: context.noteIdentity,
      operationId: request.operationId,
      storageLayout: context.storageLayout,
    };
    const source = this.#options.session.snapshot.source;
    if (source.kind !== "durable") {
      return Promise.resolve(Object.freeze({ kind: "rejected" }));
    }
    this.#request = request;
    this.#markerCorrelation = Object.freeze({
      command,
      priorSourceDigest: source.digest,
      priorSourceGeneration: source.generation,
    });
    const preparation = this.#coordinator.prepare(command);
    void preparation.then(
      (result) => {
        if (result.kind !== "prepared") this.#clearRequest();
      },
      () => {
        this.#clearRequest();
      },
    );
    return preparation;
  }

  public recordHostForward(
    attempt: HostRecordedForwardAttemptV1,
  ): Promise<FirstSidecarCompletionResultV1> {
    const completion = this.#coordinator.recordHostForward({ attempt });
    void completion.then(
      (result) => {
        if (result.kind !== "rejected") this.#clearRequest();
      },
      () => {
        this.#clearRequest();
      },
    );
    return completion;
  }

  public async dispose(): Promise<void> {
    this.#clearRequest();
    await this.#coordinator.dispose();
  }

  public async loadCreated(): Promise<RuntimeFirstSidecarAdoptionV1 | null> {
    const context = this.#options.readContext();
    const loaded = await loadRuntimeSidecarV1(
      this.#options.repository,
      context.expectedVaultRelativePath,
      this.#options.persistenceCodecPort,
    );
    if (loaded.kind !== "current") return null;
    const digest = await digestRuntimeTextV1(
      loaded.rawText,
      this.#options.sourceDigestWorkPort,
    );
    if (digest === null) return null;
    return Object.freeze({
      base: Object.freeze({
        markdownPath: context.noteIdentity.vaultRelativeMarkdownPath,
        rawTextSha256: digest,
        revision: createSidecarRevision(1),
        vaultRelativePath: loaded.file.path,
      }),
      file: loaded.file,
      layout: loaded.sidecar.storageLayout,
      rawText: loaded.rawText,
    });
  }

  #createCoordinatorPorts(): FirstSidecarPortsV1<TDispatch> {
    return {
      acknowledgeRecovery: (acknowledgement): Promise<CommandResultV1<void>> =>
        this.#options.acknowledgeRecovery.acknowledgeSidecar(acknowledgement),
      admitNewSidecar: () => this.#admitNewSidecar(),
      awaitOwnedSourceCheckpoint: (_command, signal) =>
        this.#awaitMarkerCheckpoint(signal),
      createIfAbsent: (request) => this.#createIfAbsent(request),
      nowEpochMs: this.#options.nowEpochMs,
      prepareDispatch: (
        _command,
        evidence,
        signal,
      ): Promise<FirstSidecarDispatchPreparationV1<TDispatch>> => {
        const request = this.#request;
        return request === null
          ? Promise.resolve(Object.freeze({ kind: "rejected" }))
          : this.#options.prepareDispatch(request, evidence, signal);
      },
      revalidate: (command, evidence, snapshot) =>
        this.#matchesCurrentContext(command) &&
        this.#options.revalidateSource(evidence, snapshot),
      session: this.#options.session,
      timer: {
        schedule: (delayMs, callback): (() => void) => {
          const handle = globalThis.setTimeout(callback, delayMs);
          return (): void => globalThis.clearTimeout(handle);
        },
      },
      writeMarker: (command, signal) => this.#writeMarker(command, signal),
    };
  }

  #admitNewSidecar(): CommandResultV1<void> {
    let gate: FirstSidecarRelocationGateV1;
    try {
      gate = this.#options.readRelocationGate();
    } catch {
      return commandFailure("read-only-mode");
    }
    if (canAdmitFirstSidecarCreation(gate)) {
      return commandSuccess(undefined);
    }
    return commandFailure(
      gate.policyCreationBlocked ? "read-only-mode" : "relocation-pending",
    );
  }

  async #awaitMarkerCheckpoint(
    signal: AbortSignal,
  ): Promise<FirstSidecarSourceEvidenceV1 | null> {
    const correlation = this.#markerCorrelation;
    if (correlation === null) return null;
    const evidence = await this.#options.awaitObservedMarkerCheckpoint(
      signal,
      correlation,
    );
    if (
      evidence === null ||
      evidence.digest === correlation.priorSourceDigest ||
      Number(evidence.generation) !==
        Number(correlation.priorSourceGeneration) + 1
    ) {
      return null;
    }
    return evidence;
  }

  #clearRequest(): void {
    this.#request = null;
    this.#markerCorrelation = null;
  }

  async #writeMarker(
    command: FirstSidecarCommandV1,
    signal: AbortSignal,
  ): Promise<{ readonly kind: "acknowledged" } | { readonly kind: "failed" }> {
    const noteFile = this.#options.readNoteFile();
    if (noteFile?.path !== command.noteIdentity.vaultRelativeMarkdownPath) {
      return { kind: "failed" };
    }
    try {
      const result = await this.#options.marker.set(
        noteFile,
        command.expectedVaultRelativePath,
        signal,
      );
      return result.kind === "acknowledged"
        ? result
        : Object.freeze({ kind: "failed" });
    } catch {
      return Object.freeze({ kind: "failed" });
    }
  }

  async #createIfAbsent(
    request: FirstSidecarCreateRequestV1,
  ): Promise<FirstSidecarCreateResultV1> {
    const permit = await this.#options.permits.acquire(request.signal);
    if (permit === null) return { kind: "failed" };
    try {
      const prepared = await this.#encode(request.sidecar, request.signal);
      if (prepared === null) return { kind: "failed" };
      const digest = await digestRuntimeTextV1(
        prepared.rawText,
        this.#options.sourceDigestWorkPort,
      );
      if (digest === null || request.signal.aborted) return { kind: "failed" };
      const created = await this.#options.repository.createIfAbsent(
        request.expectedVaultRelativePath,
        prepared,
        request.signal,
      );
      if (created.kind === "collision") return { kind: "collision" };
      return created.kind === "acknowledged"
        ? { kind: "created", rawTextSha256: digest }
        : { kind: "failed" };
    } finally {
      permit.release();
    }
  }

  async #encode(
    sidecar: InkbookSidecarV1,
    signal: AbortSignal,
  ): Promise<{ readonly rawText: string; readonly utf8Bytes: number } | null> {
    let submission;
    try {
      submission = this.#options.persistenceCodecPort.submit(
        createPersistenceEncodeWorkV1(
          sidecar,
          this.#options.writableTier,
          PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1,
          SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1[this.#options.writableTier],
        ),
      );
    } catch {
      return null;
    }
    const cancel = (): void => submission.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await submission.result;
      if (result.kind !== "encoded-sidecar" || signal.aborted) return null;
      return Object.freeze({
        rawText: new TextDecoder("utf-8", { fatal: true }).decode(result.bytes),
        utf8Bytes: result.bytes.byteLength,
      });
    } catch {
      return null;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  #matchesCurrentContext(command: FirstSidecarCommandV1): boolean {
    let current: RuntimeFirstSidecarContextV1;
    try {
      current = this.#options.readContext();
    } catch {
      return false;
    }
    return (
      sameIdentity(current.noteIdentity, command.noteIdentity) &&
      current.expectedSettingsRevision === command.expectedSettingsRevision &&
      current.expectedVaultRelativePath === command.expectedVaultRelativePath &&
      sameLayout(current.storageLayout, command.storageLayout)
    );
  }
}

export function createRuntimeFirstSidecarV1<TDispatch>(
  options: RuntimeFirstSidecarOptionsV1<TDispatch>,
): RuntimeFirstSidecarV1<TDispatch> {
  return new RuntimeFirstSidecarV1(options);
}

export function bindRuntimeFirstSidecarV1(options: {
  readonly awaitObservedMarkerCheckpoint: RuntimeFirstSidecarOptionsV1<unknown>["awaitObservedMarkerCheckpoint"];
  readonly config: RuntimePersistenceConfigV1;
  readonly marker: SidecarMarkerWriter;
  readonly readBase: () => import("../../application/recovery").SidecarBaseIdentityV1;
  readonly readIdentity: () => NoteIdentityV1;
  readonly readRelocationGate: RuntimeFirstSidecarOptionsV1<unknown>["readRelocationGate"];
  readonly repository: VaultSidecarRepository;
  readonly session: NoteSessionV1;
}): RuntimeFirstSidecarV1<
  Extract<PrepareHostEffectResultV1, { readonly kind: "prepared" }>
> {
  const { config } = options;
  return createRuntimeFirstSidecarV1({
    acknowledgeRecovery: config.recovery,
    awaitObservedMarkerCheckpoint: options.awaitObservedMarkerCheckpoint,
    marker: options.marker,
    nowEpochMs: (): number => Date.now(),
    permits: config.permits,
    persistenceCodecPort: config.persistenceCodecPort,
    prepareDispatch: async (request, evidence) => {
      const base = options.readBase();
      config.history.updatePersistenceContext(
        base,
        evidence.generation,
        evidence.digest,
      );
      return config.history.prepareDispatch(request);
    },
    readContext: () => ({
      expectedSettingsRevision: config.settingsRevision,
      expectedVaultRelativePath: options.readBase().vaultRelativePath,
      noteIdentity: options.readIdentity(),
      storageLayout: sidecarStoragePolicyToLayout(config.storagePolicy, {
        normalizePath: config.vault.normalizePath,
      }),
    }),
    readNoteFile: () =>
      config.resolveMarkdownFile(
        options.readIdentity().vaultRelativeMarkdownPath,
      ),
    readRelocationGate: options.readRelocationGate,
    repository: options.repository,
    revalidateSource: (evidence, snapshot): boolean =>
      snapshot.source.kind === "durable" &&
      snapshot.source.digest === evidence.digest &&
      snapshot.source.generation === evidence.generation,
    session: options.session,
    sourceDigestWorkPort: config.sourceDigestWorkPort,
    writableTier: config.writableTier,
  });
}

function sameIdentity(left: NoteIdentityV1, right: NoteIdentityV1): boolean {
  return (
    left.vaultIdHint === right.vaultIdHint &&
    left.vaultRelativeMarkdownPath === right.vaultRelativeMarkdownPath
  );
}

function sameLayout(
  left: SidecarStorageLayoutV1,
  right: SidecarStorageLayoutV1,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "adjacent" ||
      (right.kind === "vault-root" &&
        left.vaultRelativeRoot === right.vaultRelativeRoot))
  );
}
