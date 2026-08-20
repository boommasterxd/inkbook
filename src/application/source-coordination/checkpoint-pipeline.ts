import { commandFailure, commandSuccess } from "../note-session/results";
import type {
  CommandErrorCodeV1,
  CommandResultV1,
  SessionOrder,
  Sha256Digest,
  SourceCheckpointId,
  SourceGeneration,
} from "../note-session/types";
import type { SidecarBaseIdentityV1 } from "../recovery/base";
import type { RecoveryStore } from "../recovery/port";
import { isValidSidecarBase } from "../recovery/validation";
import {
  appendSourceCheckpointFailClosed,
  type ActiveSourceCheckpointV1,
  type ForcedSourceBarrierV1,
  type PendingSourceCheckpointV1,
  type SourceBarrierWaiterV1,
  type SourceCheckpointSchedulerV1,
  type SourceCheckpointTimerHandleV1,
} from "./checkpoints";
import type { SourceMapGraphNodeV1 } from "./map-graph";
import type {
  SourceCheckpointOperationV1,
  SourceOffsetMapIdentityV1,
  SourceSnapshotV1,
} from "./types";

const IDLE_DEBOUNCE_MS = 100;
const MAXIMUM_DIRTY_MS = 500;

export interface SourceCheckpointPipelineOptionsV1 {
  readonly createCheckpointId: () => SourceCheckpointId;
  readonly initialSource: SourceMapGraphNodeV1;
  readonly nextSessionOrder: () => SessionOrder;
  readonly onChanged: () => void;
  readonly onDurableCheckpoint?: (
    checkpoint: SourceCheckpointOperationV1,
    snapshot: SourceSnapshotV1,
  ) => void;
  readonly onSaveGeneration?: (
    generation: SourceGeneration,
    digest: Sha256Digest,
  ) => void;
  readonly readBase: () => SidecarBaseIdentityV1;
  readonly recoveryStore: Pick<RecoveryStore, "appendSourceCheckpoint">;
  readonly scheduler: SourceCheckpointSchedulerV1;
}

export interface SourceCheckpointRetainedOwnershipV1 {
  readonly maps: readonly SourceOffsetMapIdentityV1[];
  readonly roots: readonly SourceMapGraphNodeV1[];
}

export class SourceCheckpointPipelineV1 {
  readonly #options: SourceCheckpointPipelineOptionsV1;
  readonly #barriers: SourceBarrierWaiterV1[] = [];
  #active: ActiveSourceCheckpointV1 | null = null;
  #blocked: CommandErrorCodeV1 | null = null;
  #dirtySince: number | null = null;
  #disposed = false;
  #durable: SourceMapGraphNodeV1;
  #failure: CommandErrorCodeV1 | null = null;
  #forcedThrough: SourceGeneration | null = null;
  #latest: PendingSourceCheckpointV1 | null = null;
  #nextToken = 1;
  #persistingToken: number | null = null;
  #timer: SourceCheckpointTimerHandleV1 | null = null;

  constructor(options: SourceCheckpointPipelineOptionsV1) {
    this.#options = options;
    this.#durable = options.initialSource;
  }

  get active(): ActiveSourceCheckpointV1 | null {
    return this.#active;
  }

  get durable(): SourceMapGraphNodeV1 {
    return this.#durable;
  }

  get failure(): CommandErrorCodeV1 | null {
    return this.#failure;
  }

  get latest(): PendingSourceCheckpointV1 | null {
    return this.#latest;
  }

  get retainedOwnership(): SourceCheckpointRetainedOwnershipV1 {
    const roots: SourceMapGraphNodeV1[] = [];
    const maps: SourceOffsetMapIdentityV1[] = [];
    for (const checkpoint of [this.#active, this.#latest]) {
      if (checkpoint === null) continue;
      roots.push(checkpoint.prior, checkpoint.replacement);
      maps.push(checkpoint.mapIdentity);
    }
    return Object.freeze({
      maps: Object.freeze(maps),
      roots: Object.freeze(roots),
    });
  }

  setLatest(latest: PendingSourceCheckpointV1): void {
    if (this.#disposed || this.#blocked !== null) return;
    this.#latest = latest;
    this.#failure = null;
    this.#schedule();
    this.#changed();
  }

  beginForcedBarrier(generation: SourceGeneration): ForcedSourceBarrierV1 {
    if (this.#disposed) {
      return Object.freeze({
        completion: Promise.resolve(commandFailure("disposed")),
        generation,
      });
    }
    if (this.#blocked !== null) {
      return Object.freeze({
        completion: Promise.resolve(commandFailure(this.#blocked)),
        generation,
      });
    }
    this.#cancelTimer();
    this.#forcedThrough = generation;
    const completion =
      generation <= this.#durable.generation
        ? Promise.resolve(commandSuccess(this.#durable))
        : new Promise<CommandResultV1<SourceMapGraphNodeV1>>((resolve) => {
            this.#barriers.push(Object.freeze({ generation, resolve }));
          });
    this.#promoteLatest();
    return Object.freeze({ completion, generation });
  }

  retry(): CommandResultV1<void> {
    if (this.#disposed) return commandFailure("disposed");
    if (this.#blocked !== null) return commandFailure(this.#blocked);
    this.#failure = null;
    this.#changed();
    if (this.#active === null) {
      this.#promoteLatest();
      return commandSuccess(undefined);
    }
    if (this.#persistingToken === null) void this.#persistActive(this.#active);
    return commandSuccess(undefined);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelTimer();
    this.#active = null;
    this.#persistingToken = null;
    this.#latest = null;
    this.#resolveBarriers(commandFailure("disposed"));
  }

  block(code: CommandErrorCodeV1): void {
    if (this.#disposed || this.#blocked !== null) return;
    this.#blocked = code;
    this.#failure = code;
    this.#cancelTimer();
    this.#resolveBarriers(commandFailure(code));
    this.#changed();
  }

  #schedule(): void {
    const now = this.#options.scheduler.now();
    this.#dirtySince ??= now;
    if (this.#active !== null) return;
    this.#cancelTimer();
    const maximumDelay = Math.max(0, this.#dirtySince + MAXIMUM_DIRTY_MS - now);
    const delay = Math.min(IDLE_DEBOUNCE_MS, maximumDelay);
    this.#timer = this.#options.scheduler.schedule(delay, () => {
      this.#timer = null;
      this.#promoteLatest();
    });
  }

  #promoteLatest(): void {
    if (this.#disposed || this.#active !== null || this.#latest === null)
      return;
    const pending = this.#latest;
    const checkpoint = this.#createCheckpoint(pending);
    if (!checkpoint.ok) {
      this.#failure = checkpoint.code;
      this.#changed();
      this.#resolveBarriers(commandFailure(checkpoint.code));
      return;
    }
    this.#latest = null;
    this.#dirtySince = null;
    const active = Object.freeze({
      ...pending,
      checkpoint: checkpoint.value,
      token: this.#nextToken,
    });
    this.#nextToken += 1;
    this.#active = active;
    this.#changed();
    void this.#persistActive(active);
  }

  async #persistActive(active: ActiveSourceCheckpointV1): Promise<void> {
    if (this.#persistingToken === active.token) return;
    this.#persistingToken = active.token;
    const result = await appendSourceCheckpointFailClosed(
      this.#options.recoveryStore,
      active.checkpoint,
    );
    if (this.#disposed || this.#active !== active) return;
    this.#persistingToken = null;
    if (!result.ok) {
      this.#failure = result.code;
      this.#changed();
      return;
    }
    this.#active = null;
    this.#durable = active.replacement;
    this.#failure = this.#blocked;
    if (this.#blocked !== null) {
      this.#changed();
      return;
    }
    try {
      this.#options.onDurableCheckpoint?.(
        active.checkpoint,
        active.replacement.snapshot,
      );
      this.#options.onSaveGeneration?.(
        active.replacement.generation,
        active.replacement.digest,
      );
    } catch {
      this.#failure = "recovery-unavailable";
    }
    this.#changed();
    this.#resolveSatisfiedBarriers();
    if (
      this.#forcedThrough !== null &&
      this.#forcedThrough > this.#durable.generation
    ) {
      this.#promoteLatest();
    } else if (this.#latest !== null) this.#schedule();
  }

  #createCheckpoint(
    pending: PendingSourceCheckpointV1,
  ): CommandResultV1<SourceCheckpointOperationV1> {
    let base: SidecarBaseIdentityV1;
    try {
      base = this.#options.readBase();
    } catch {
      return commandFailure("sidecar-conflict");
    }
    if (!isValidSidecarBase(base)) return commandFailure("sidecar-conflict");
    try {
      return commandSuccess(
        Object.freeze({
          base: Object.freeze({ ...base }),
          checkpointId: this.#options.createCheckpointId(),
          offsetMap: pending.mapIdentity.offsetMap,
          priorDigest: pending.prior.digest,
          priorGeneration: pending.prior.generation,
          priorUtf16Length: pending.prior.snapshot.utf16Length,
          replacementDigest: pending.replacement.digest,
          replacementGeneration: pending.replacement.generation,
          replacementUtf16Length: pending.replacement.snapshot.utf16Length,
          sessionOrder: this.#options.nextSessionOrder(),
        }),
      );
    } catch {
      return commandFailure("recovery-unavailable");
    }
  }

  #resolveSatisfiedBarriers(): void {
    const remaining: SourceBarrierWaiterV1[] = [];
    for (const waiter of this.#barriers) {
      if (waiter.generation <= this.#durable.generation) {
        waiter.resolve(commandSuccess(this.#durable));
      } else remaining.push(waiter);
    }
    this.#barriers.length = 0;
    this.#barriers.push(...remaining);
    if (
      this.#forcedThrough !== null &&
      this.#forcedThrough <= this.#durable.generation
    ) {
      this.#forcedThrough = null;
    }
  }

  #resolveBarriers(result: CommandResultV1<SourceMapGraphNodeV1>): void {
    for (const waiter of this.#barriers) waiter.resolve(result);
    this.#barriers.length = 0;
  }

  #cancelTimer(): void {
    if (this.#timer === null) return;
    this.#options.scheduler.cancel(this.#timer);
    this.#timer = null;
  }

  #changed(): void {
    try {
      this.#options.onChanged();
    } catch {
      this.#failure = "recovery-unavailable";
    }
  }
}
