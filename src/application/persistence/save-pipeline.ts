import type { SceneRevision } from "../../domain/model";
import {
  createSidecarRevision,
  type NoteIdentityV1,
  type RecoveryAttemptId,
  type SaveGeneration,
  type Sha256Digest,
  type SourceCheckpointId,
  type SourceGeneration,
} from "../note-session";
import type {
  SidecarBaseIdentityV1,
  SidecarRecoveryAcknowledgementV1,
} from "../recovery";

export type PersistencePlatformTierV1 = "phone" | "desktop-tablet";

const PHONE_PIPELINE_LIMIT = 1;
const DESKTOP_TABLET_PIPELINE_LIMIT = 2;

export interface SaveCaptureV1<TSnapshot> {
  readonly snapshot: TSnapshot;
  readonly sceneRevision: SceneRevision;
  readonly sourceGeneration: SourceGeneration;
  readonly sourceDigest: Sha256Digest;
}

export interface SaveGenerationRequestV1<TSnapshot> {
  readonly generation: SaveGeneration;
  readonly coveredAttemptIds: readonly RecoveryAttemptId[];
  readonly coveredCheckpointIds: readonly SourceCheckpointId[];
  readonly capture: () => SaveCaptureV1<TSnapshot>;
}

export interface EncodeSaveRequestV1<TSnapshot> {
  readonly capture: SaveCaptureV1<TSnapshot>;
  readonly revision: number;
  readonly baseRevision: number | null;
  readonly savedAtEpochMs: number;
  readonly signal: AbortSignal;
}

export interface EncodedSaveV1<TPayload> {
  readonly payload: TPayload;
  readonly rawTextSha256: Sha256Digest;
}

export interface PreparedVaultWriteV1<TPayload> {
  readonly kind: "compare-and-process";
  readonly expectedPriorBase: SidecarBaseIdentityV1;
  readonly acknowledgedReplacementBase: SidecarBaseIdentityV1;
  readonly revision: number;
  readonly baseRevision: number | null;
  readonly savedAtEpochMs: number;
  readonly payload: TPayload;
  readonly signal: AbortSignal;
}

export type PreparedVaultWriteResultV1 =
  | { readonly kind: "written" }
  | { readonly kind: "conflict" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed" };

export interface SavePipelinePortsV1<TSnapshot, TPayload> {
  readonly encode: (
    request: EncodeSaveRequestV1<TSnapshot>,
  ) => Promise<EncodedSaveV1<TPayload>>;
  readonly prepareVaultWrite: (
    request: PreparedVaultWriteV1<TPayload>,
  ) => Promise<PreparedVaultWriteResultV1>;
  readonly acknowledgeRecovery: (
    request: SidecarRecoveryAcknowledgementV1,
  ) => Promise<{ readonly ok: boolean }>;
  readonly nowEpochMs: () => number;
}

export type SavePipelineResultV1 =
  | { readonly kind: "acknowledged"; readonly clearedLatestDirty: boolean }
  | {
      readonly kind:
        | "cancelled"
        | "conflict"
        | "disposed"
        | "failed"
        | "recovery-conflict"
        | "rejected"
        | "replaced"
        | "stale";
    };

interface PersistencePermitV1 {
  release(): void;
}

interface PermitWaiter {
  readonly signal: AbortSignal;
  readonly resolve: (permit: PersistencePermitV1 | null) => void;
  readonly onAbort: () => void;
}

export class PersistencePermitPool {
  readonly limit: number;
  private active = 0;
  private readonly waiting: PermitWaiter[] = [];

  constructor(tier: PersistencePlatformTierV1) {
    this.limit =
      tier === "phone" ? PHONE_PIPELINE_LIMIT : DESKTOP_TABLET_PIPELINE_LIMIT;
  }

  get activeCount(): number {
    return this.active;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  acquire(signal: AbortSignal): Promise<PersistencePermitV1 | null> {
    if (signal.aborted) return Promise.resolve(null);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.createPermit());
    }
    return new Promise((resolve) => {
      const waiter: PermitWaiter = {
        signal,
        resolve,
        onAbort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          resolve(null);
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private createPermit(): PersistencePermitV1 {
    let released = false;
    return Object.freeze({
      release: (): void => {
        if (released) return;
        released = true;
        this.release();
      },
    });
  }

  private release(): void {
    while (this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (next === undefined) break;
      next.signal.removeEventListener("abort", next.onAbort);
      if (next.signal.aborted) {
        next.resolve(null);
        continue;
      }
      next.resolve(this.createPermit());
      return;
    }
    this.active -= 1;
  }
}

interface SaveJob<TSnapshot> {
  readonly generation: SaveGeneration;
  coveredAttemptIds: RecoveryAttemptId[];
  coveredCheckpointIds: SourceCheckpointId[];
  readonly capture: () => SaveCaptureV1<TSnapshot>;
  readonly abort: AbortController;
  readonly resolve: (result: SavePipelineResultV1) => void;
}

export class SavePipeline<TSnapshot, TPayload> {
  private active: SaveJob<TSnapshot> | null = null;
  private waiting: SaveJob<TSnapshot> | null = null;
  private base: SidecarBaseIdentityV1;
  private latestDirty: SaveGeneration | null = null;
  private disposed = false;
  private blocked: boolean;
  private retryCoverage: RecoveryCoverageV1 | null = null;
  private readonly drainWaiters: (() => void)[] = [];

  constructor(
    private readonly noteIdentity: NoteIdentityV1,
    initialBase: SidecarBaseIdentityV1,
    private readonly permits: PersistencePermitPool,
    private readonly ports: SavePipelinePortsV1<TSnapshot, TPayload>,
  ) {
    this.base = Object.freeze({ ...initialBase });
    this.blocked =
      initialBase.revision === null || initialBase.rawTextSha256 === null;
  }

  get snapshot(): Readonly<{
    activeGeneration: SaveGeneration | null;
    waitingGeneration: SaveGeneration | null;
    latestDirtyGeneration: SaveGeneration | null;
    currentBase: SidecarBaseIdentityV1;
    disposed: boolean;
  }> {
    return Object.freeze({
      activeGeneration: this.active?.generation ?? null,
      waitingGeneration: this.waiting?.generation ?? null,
      latestDirtyGeneration: this.latestDirty,
      currentBase: this.base,
      disposed: this.disposed,
    });
  }

  enqueue(
    request: SaveGenerationRequestV1<TSnapshot>,
  ): Promise<SavePipelineResultV1> {
    if (this.disposed || this.blocked) {
      return Promise.resolve({ kind: this.disposed ? "disposed" : "rejected" });
    }
    const retryingLatest =
      request.generation === this.latestDirty &&
      this.active === null &&
      this.waiting === null &&
      this.retryCoverage !== null;
    if (
      !retryingLatest &&
      this.latestDirty !== null &&
      request.generation <= this.latestDirty
    ) {
      return Promise.resolve({ kind: "rejected" });
    }
    this.latestDirty = request.generation;
    return new Promise((resolve) => {
      const job = this.createJob(request, resolve);
      mergeCoverage(job, this.retryCoverage);
      this.retryCoverage = null;
      if (this.active === null) {
        this.active = job;
        void this.run(job);
        return;
      }
      if (this.waiting !== null) {
        job.coveredAttemptIds = mergeIds(
          this.waiting.coveredAttemptIds,
          job.coveredAttemptIds,
        );
        job.coveredCheckpointIds = mergeIds(
          this.waiting.coveredCheckpointIds,
          job.coveredCheckpointIds,
        );
        this.waiting.resolve({ kind: "replaced" });
        this.waiting.abort.abort();
      }
      this.waiting = job;
    });
  }

  cancel(generation: SaveGeneration): boolean {
    if (this.waiting?.generation === generation) {
      this.waiting.abort.abort();
      this.waiting.resolve({ kind: "cancelled" });
      this.waiting = null;
      return true;
    }
    if (this.active?.generation !== generation) return false;
    this.active.abort.abort();
    return true;
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      if (this.waiting !== null) {
        this.waiting.abort.abort();
        this.waiting.resolve({ kind: "disposed" });
        this.waiting = null;
      }
      this.active?.abort.abort();
    }
    if (this.active === null) return;
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  private createJob(
    request: SaveGenerationRequestV1<TSnapshot>,
    resolve: (result: SavePipelineResultV1) => void,
  ): SaveJob<TSnapshot> {
    return {
      ...request,
      coveredAttemptIds: [...request.coveredAttemptIds],
      coveredCheckpointIds: [...request.coveredCheckpointIds],
      abort: new AbortController(),
      resolve,
    };
  }

  private async run(job: SaveJob<TSnapshot>): Promise<void> {
    const permit = await this.permits.acquire(job.abort.signal);
    if (permit === null) {
      this.finish(job, { kind: this.disposed ? "disposed" : "cancelled" });
      return;
    }
    try {
      const result = await this.execute(job);
      this.finish(job, result);
    } finally {
      permit.release();
    }
  }

  private async execute(
    job: SaveJob<TSnapshot>,
  ): Promise<SavePipelineResultV1> {
    let writeCommitted = false;
    try {
      const prior = this.base;
      const revision = (prior.revision ?? 0) + 1;
      const baseRevision = prior.revision;
      const capture = job.capture();
      const savedAtEpochMs = this.ports.nowEpochMs();
      const encoded = await this.ports.encode({
        capture,
        revision,
        baseRevision,
        savedAtEpochMs,
        signal: job.abort.signal,
      });
      if (isAborted(job.abort.signal)) return this.staleResult();
      const replacement = replacementBase(
        prior,
        revision,
        encoded.rawTextSha256,
      );
      const write = await this.ports.prepareVaultWrite({
        kind: "compare-and-process",
        expectedPriorBase: prior,
        acknowledgedReplacementBase: replacement,
        revision,
        baseRevision,
        savedAtEpochMs,
        payload: encoded.payload,
        signal: job.abort.signal,
      });
      if (write.kind === "conflict") {
        this.blocked = true;
        return { kind: "conflict" };
      }
      if (write.kind === "cancelled") return this.staleResult();
      if (write.kind === "failed") return { kind: "failed" };
      writeCommitted = true;
      if (isAborted(job.abort.signal)) {
        this.blocked = true;
        return this.staleResult();
      }
      const acknowledged = await this.ports.acknowledgeRecovery(
        acknowledgement(this.noteIdentity, prior, replacement, capture, job),
      );
      if (isAborted(job.abort.signal)) {
        this.blocked = true;
        return this.staleResult();
      }
      if (!acknowledged.ok) {
        this.blocked = true;
        return { kind: "recovery-conflict" };
      }
      this.base = replacement;
      const clearedLatestDirty = this.latestDirty === job.generation;
      if (clearedLatestDirty) this.latestDirty = null;
      return { kind: "acknowledged", clearedLatestDirty };
    } catch {
      if (writeCommitted) {
        this.blocked = true;
        return isAborted(job.abort.signal)
          ? this.staleResult()
          : { kind: "recovery-conflict" };
      }
      return isAborted(job.abort.signal)
        ? this.staleResult()
        : { kind: "failed" };
    }
  }

  private staleResult(): SavePipelineResultV1 {
    return { kind: this.disposed ? "disposed" : "cancelled" };
  }

  private finish(job: SaveJob<TSnapshot>, result: SavePipelineResultV1): void {
    if (this.active !== job) return;
    this.active = null;
    job.resolve(result);
    if (result.kind === "failed" && this.waiting === null) {
      this.retryCoverage = coverage(job);
    }
    if (this.disposed || this.blocked) {
      if (this.waiting !== null) {
        this.waiting.resolve({ kind: this.disposed ? "disposed" : "stale" });
        this.waiting.abort.abort();
        this.waiting = null;
      }
      this.resolveDrain();
      return;
    }
    const next = this.waiting;
    this.waiting = null;
    if (next === null) {
      this.resolveDrain();
      return;
    }
    if (result.kind !== "acknowledged") {
      next.coveredAttemptIds = mergeIds(
        job.coveredAttemptIds,
        next.coveredAttemptIds,
      );
      next.coveredCheckpointIds = mergeIds(
        job.coveredCheckpointIds,
        next.coveredCheckpointIds,
      );
    }
    this.active = next;
    void this.run(next);
  }

  private resolveDrain(): void {
    for (const resolve of this.drainWaiters.splice(0)) resolve();
  }
}

interface RecoveryCoverageV1 {
  readonly coveredAttemptIds: readonly RecoveryAttemptId[];
  readonly coveredCheckpointIds: readonly SourceCheckpointId[];
}

function coverage<TSnapshot>(job: SaveJob<TSnapshot>): RecoveryCoverageV1 {
  return Object.freeze({
    coveredAttemptIds: Object.freeze([...job.coveredAttemptIds]),
    coveredCheckpointIds: Object.freeze([...job.coveredCheckpointIds]),
  });
}

function mergeCoverage<TSnapshot>(
  job: SaveJob<TSnapshot>,
  prior: RecoveryCoverageV1 | null,
): void {
  if (prior === null) return;
  job.coveredAttemptIds = mergeIds(
    prior.coveredAttemptIds,
    job.coveredAttemptIds,
  );
  job.coveredCheckpointIds = mergeIds(
    prior.coveredCheckpointIds,
    job.coveredCheckpointIds,
  );
}

function mergeIds<T>(prior: readonly T[], latest: readonly T[]): T[] {
  return [...new Set([...prior, ...latest])];
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function replacementBase(
  prior: SidecarBaseIdentityV1,
  revision: number,
  rawTextSha256: Sha256Digest,
): SidecarBaseIdentityV1 {
  return Object.freeze({
    ...prior,
    revision: createSidecarRevision(revision),
    rawTextSha256,
  });
}

function acknowledgement<TSnapshot>(
  noteIdentity: NoteIdentityV1,
  prior: SidecarBaseIdentityV1,
  replacement: SidecarBaseIdentityV1,
  capture: SaveCaptureV1<TSnapshot>,
  job: SaveJob<TSnapshot>,
): SidecarRecoveryAcknowledgementV1 {
  return Object.freeze({
    noteIdentity,
    expectedPriorBase: prior,
    acknowledgedReplacementBase: replacement,
    coveredAttemptIds: Object.freeze([...job.coveredAttemptIds]),
    coveredCheckpointIds: Object.freeze([...job.coveredCheckpointIds]),
    sidecarRevision: replacement.revision as NonNullable<
      typeof replacement.revision
    >,
    sceneRevision: capture.sceneRevision,
    sourceGeneration: capture.sourceGeneration,
    sourceDigest: capture.sourceDigest,
  });
}
