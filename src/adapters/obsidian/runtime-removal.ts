import {
  commandFailure,
  commandSuccess,
  type CommandResultV1,
  type NoteIdentityV1,
  type RemovalId,
  createSourceGeneration,
  type Sha256Digest,
  type SourceGeneration,
} from "../../application/note-session";
import {
  beginAnnotationRemoval,
  resumeAnnotationRemovalV1,
  type AnnotationRemovalCoordinatorV1,
  type RemovalClockV1,
  type RemovalDeleteEventResultV1,
  type RemovalPortsV1,
} from "../../application/persistence";
import type {
  ActiveRemovalRecoveryV1,
  RecoveryStore,
  RemovalRecordV1,
  SidecarBaseIdentityV1,
} from "../../application/recovery";
import { sameSidecarBase } from "../../application/recovery";
import type { SidecarMarkerWriter } from "./vault-sidecar/marker";
import type { VaultFileCapability } from "./vault-sidecar/paths";
import type { ObsidianSidecarTrashPortV1 } from "./vault-sidecar/removal-trash";

type AsyncResult = Promise<CommandResultV1<void>>;
type RuntimeRemovalCallbacksV1 = Pick<
  RemovalPortsV1,
  "clearSession" | "handleExternalDelete" | "resolveFailure"
>;

export interface RuntimeRemovalConfigV1 {
  readonly callbacks: RuntimeRemovalCallbacksV1;
  readonly clock: RemovalClockV1;
  readonly marker: Pick<SidecarMarkerWriter, "remove">;
  readonly recovery: RecoveryStore;
  readonly resolveMarkdownFile: (
    identity: NoteIdentityV1,
  ) => VaultFileCapability | null;
  readonly trash: Pick<ObsidianSidecarTrashPortV1, "trashSidecar">;
}

export interface RuntimeRemovalDeleteEventV1 {
  readonly removalId: RemovalId;
  readonly sidecarBase: SidecarBaseIdentityV1;
}

interface ActiveRemovalV1 {
  clearPending: boolean;
  invalidated: boolean;
  readonly ready: Promise<CommandResultV1<AnnotationRemovalCoordinatorV1>>;
  readonly record: RemovalRecordV1;
}

interface ReadyGateV1 {
  readonly promise: Promise<CommandResultV1<AnnotationRemovalCoordinatorV1>>;
  resolve(result: CommandResultV1<AnnotationRemovalCoordinatorV1>): void;
}

/** Binds the durable removal saga to one note-scoped Obsidian runtime owner. */
export class RuntimeRemovalV1 {
  readonly #abortController = new AbortController();
  readonly #config: RuntimeRemovalConfigV1;
  readonly #ports: RemovalPortsV1;
  #active: ActiveRemovalV1 | null = null;
  #disposed = false;

  public constructor(config: RuntimeRemovalConfigV1) {
    this.#config = config;
    this.#ports = this.#createPorts();
  }

  public get hasActiveRemoval(): boolean {
    return this.#active !== null && !this.#active.invalidated;
  }

  public start(record: RemovalRecordV1): AsyncResult {
    if (this.#disposed) return Promise.resolve(commandFailure("disposed"));
    if (this.#active !== null) {
      return Promise.resolve(commandFailure("invalid-command"));
    }
    const gate = readyGate();
    const active: ActiveRemovalV1 = {
      clearPending: false,
      invalidated: false,
      ready: gate.promise,
      record,
    };
    this.#active = active;
    void this.#begin(active).then((result) => gate.resolve(result));
    return gate.promise.then((result) =>
      result.ok ? commandSuccess(undefined) : result,
    );
  }

  public async resume(bundle: ActiveRemovalRecoveryV1): AsyncResult {
    if (this.#disposed) return commandFailure("disposed");
    if (this.#active !== null) return commandFailure("invalid-command");
    const record = bundle.removal;
    const gate = readyGate();
    const active: ActiveRemovalV1 = {
      clearPending: false,
      invalidated: false,
      ready: gate.promise,
      record,
    };
    this.#active = active;
    void this.#resume(active, bundle).then((result) => gate.resolve(result));
    const result = await gate.promise;
    return result.ok ? commandSuccess(undefined) : result;
  }

  public acceptActiveDelete(
    sidecarBase: SidecarBaseIdentityV1,
  ): Promise<RemovalDeleteEventResultV1> | null {
    const removalId = this.#active?.record.removalId;
    return removalId === undefined
      ? null
      : this.acceptDeleteEvent({ removalId, sidecarBase });
  }

  public async acceptDeleteEvent(
    event: RuntimeRemovalDeleteEventV1,
  ): Promise<RemovalDeleteEventResultV1> {
    const active = this.#active;
    if (active === null || this.#disposed) {
      return this.#externalDelete(event.sidecarBase, "inactive");
    }
    if (event.removalId !== active.record.removalId) {
      active.invalidated = true;
      const ready = await active.ready;
      if (ready.ok) await ready.value.dispose();
      return this.#externalDelete(event.sidecarBase, "mismatch");
    }
    const ready = await active.ready;
    if (!ready.ok || active.invalidated || this.#active !== active) {
      return this.#externalDelete(event.sidecarBase, "inactive");
    }
    return ready.value.acceptDeleteEvent({ sidecarBase: event.sidecarBase });
  }

  public async retryCleanup(): AsyncResult {
    const active = this.#active;
    if (active === null || this.#disposed) return commandFailure("disposed");
    const ready = await active.ready;
    if (!ready.ok || active.invalidated) return commandFailure("sidecar-drift");
    return ready.value.retryCleanup();
  }

  public async whenIdle(): Promise<void> {
    const active = this.#active;
    if (active === null) return;
    const ready = await active.ready;
    if (ready.ok) await ready.value.whenIdle();
    if (active.clearPending && this.#active === active) this.#active = null;
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abortController.abort();
    const active = this.#active;
    if (active === null) return;
    active.invalidated = true;
    const ready = await active.ready;
    if (ready.ok) await ready.value.dispose();
  }

  async #begin(
    active: ActiveRemovalV1,
  ): Promise<CommandResultV1<AnnotationRemovalCoordinatorV1>> {
    const result = await beginAnnotationRemoval({
      clock: this.#config.clock,
      ports: this.#ports,
      record: active.record,
      recovery: this.#config.recovery,
    });
    if (!result.ok) {
      if (this.#active === active) this.#active = null;
      return result;
    }
    if (active.invalidated || this.#disposed || this.#active !== active) {
      await result.value.dispose();
      return commandFailure(this.#disposed ? "disposed" : "sidecar-drift");
    }
    return result;
  }

  async #resume(
    active: ActiveRemovalV1,
    bundle: ActiveRemovalRecoveryV1,
  ): Promise<CommandResultV1<AnnotationRemovalCoordinatorV1>> {
    const result = await resumeAnnotationRemovalV1({
      activeRecovery: bundle,
      clock: this.#config.clock,
      ports: this.#ports,
      recovery: this.#config.recovery,
    });
    if (!result.ok && this.#active === active) this.#active = null;
    return result;
  }

  #createPorts(): RemovalPortsV1 {
    return {
      clearSession: (record) => this.#clearSession(record),
      handleExternalDelete: (base) =>
        this.#config.callbacks.handleExternalDelete(base),
      removeMarker: (record) => this.#removeMarker(record),
      resolveFailure: (record) => this.#resolveFailure(record),
      trashSidecar: (record) => this.#config.trash.trashSidecar(record),
    };
  }

  async #clearSession(record: RemovalRecordV1): AsyncResult {
    const result = await this.#config.callbacks.clearSession(record);
    if (result.ok && this.#active?.record.removalId === record.removalId) {
      this.#active.clearPending = true;
    }
    return result;
  }

  async #resolveFailure(record: RemovalRecordV1): AsyncResult {
    const active = this.#active;
    if (active?.record.removalId === record.removalId) {
      active.invalidated = true;
      this.#active = null;
    }
    return this.#config.callbacks.resolveFailure(record);
  }

  async #removeMarker(record: RemovalRecordV1): AsyncResult {
    const file = this.#config.resolveMarkdownFile(record.noteIdentity);
    if (file === null) return commandFailure("sidecar-drift");
    try {
      const result = await this.#config.marker.remove(
        file,
        this.#abortController.signal,
      );
      return result.kind === "acknowledged"
        ? commandSuccess(undefined)
        : commandFailure("sidecar-drift");
    } catch {
      return commandFailure("sidecar-drift");
    }
  }

  async #externalDelete(
    sidecarBase: SidecarBaseIdentityV1,
    reason: "inactive" | "mismatch",
  ): Promise<RemovalDeleteEventResultV1> {
    await this.#config.callbacks.handleExternalDelete(sidecarBase);
    return Object.freeze({ consumed: false, reason });
  }
}

function readyGate(): ReadyGateV1 {
  let complete!: (
    result: CommandResultV1<AnnotationRemovalCoordinatorV1>,
  ) => void;
  const promise = new Promise<CommandResultV1<AnnotationRemovalCoordinatorV1>>(
    (resolve) => {
      complete = resolve;
    },
  );
  return { promise, resolve: complete };
}

export function runtimeRemovalSourceEvidenceV1(
  bundle: ActiveRemovalRecoveryV1,
  currentDigest: Sha256Digest,
): Readonly<{ digest: Sha256Digest; generation: SourceGeneration }> | null {
  const checkpoint = bundle.checkpoints.at(Number("-1"));
  if (checkpoint !== undefined)
    return checkpoint.replacementDigest === currentDigest
      ? Object.freeze({
          digest: currentDigest,
          generation: checkpoint.replacementGeneration,
        })
      : null;
  const attempt = bundle.attempts.at(Number("-1"));
  if (attempt !== undefined)
    return attempt.expectedSourceDigest === currentDigest
      ? Object.freeze({
          digest: currentDigest,
          generation: attempt.expectedSourceGeneration,
        })
      : null;
  return Object.freeze({
    digest: currentDigest,
    generation: createSourceGeneration(1),
  });
}

export function runtimeRemovalMatchesBaseV1(
  bundle: ActiveRemovalRecoveryV1,
  identity: NoteIdentityV1,
  base: SidecarBaseIdentityV1,
  sceneRevision: number,
): boolean {
  const removal = bundle.removal;
  return (
    removal.noteIdentity.vaultIdHint === identity.vaultIdHint &&
    removal.noteIdentity.vaultRelativeMarkdownPath ===
      identity.vaultRelativeMarkdownPath &&
    sameSidecarBase(removal.sidecarBase, base) &&
    Number(removal.expectedSceneRevision) === sceneRevision
  );
}
