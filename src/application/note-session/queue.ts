export type NoteSessionTurnKindV1 =
  | "command"
  | "history"
  | "lifecycle"
  | "source"
  | "recovery-acknowledgement"
  | "persistence"
  | "save"
  | "checkpoint"
  | "worker"
  | "view";

export interface NoteSessionQueueLimitsV1 {
  readonly maxTurns: number;
  readonly maxRetainedBytes: number;
  readonly reservedCriticalTurns: number;
  readonly reservedCriticalBytes: number;
}

export interface NoteSessionQueueCapacityV1 {
  tryReserve(critical: boolean): boolean;
  release(critical: boolean): void;
}

export interface ReplaceableSessionTurnV1 {
  readonly key: string;
  readonly revision: number;
}

export interface NoteSessionQueueTurnV1 {
  readonly kind: NoteSessionTurnKindV1;
  readonly retainedBytes: number;
  readonly replacement?: ReplaceableSessionTurnV1;
  readonly run: (signal: AbortSignal) => Promise<void> | void;
}

export type NoteSessionTurnResultV1 =
  | { readonly kind: "completed" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "replaced" }
  | { readonly kind: "superseded" }
  | { readonly kind: "failed"; readonly error: unknown }
  | {
      readonly kind: "rejected";
      readonly reason: "disposed" | "resource-limit";
    };

interface QueueEntryV1 {
  readonly turn: NoteSessionQueueTurnV1;
  readonly critical: boolean;
  readonly controller: AbortController;
  readonly settle: (result: NoteSessionTurnResultV1) => void;
}

const REPLACEABLE_KINDS = new Set<NoteSessionTurnKindV1>([
  "checkpoint",
  "save",
  "view",
  "worker",
]);

const NO_CAPACITY: NoteSessionQueueCapacityV1 = Object.freeze({
  release: (): void => undefined,
  tryReserve: (): boolean => true,
});

export class NoteSessionQueueV1 {
  readonly #limits: NoteSessionQueueLimitsV1;
  readonly #capacity: NoteSessionQueueCapacityV1;
  readonly #schedule: (task: () => void) => void;
  readonly #pending: QueueEntryV1[] = [];
  readonly #idleWaiters = new Set<() => void>();
  #active: QueueEntryV1 | null = null;
  #retainedTurns = 0;
  #ordinaryTurns = 0;
  #retainedBytes = 0;
  #ordinaryBytes = 0;
  #scheduled = false;
  #disposed = false;

  public constructor(config: {
    readonly limits: NoteSessionQueueLimitsV1;
    readonly capacity?: NoteSessionQueueCapacityV1;
    readonly schedule?: (task: () => void) => void;
  }) {
    validateLimits(config.limits);
    this.#limits = Object.freeze({ ...config.limits });
    this.#capacity = config.capacity ?? NO_CAPACITY;
    this.#schedule = config.schedule ?? queueMicrotask;
  }

  public get retainedTurns(): number {
    return this.#retainedTurns;
  }

  public get retainedBytes(): number {
    return this.#retainedBytes;
  }

  public get isDisposed(): boolean {
    return this.#disposed;
  }

  public enqueue(
    turn: NoteSessionQueueTurnV1,
  ): Promise<NoteSessionTurnResultV1> {
    validateTurn(turn);
    if (this.#disposed) return immediateRejection("disposed");
    const replacement = this.#replacePending(turn);
    if (replacement !== null) return replacement;
    const critical = isCritical(turn.kind);
    if (!this.#fits(turn, critical) || !this.#capacity.tryReserve(critical)) {
      return immediateRejection("resource-limit");
    }
    const completion = new Promise<NoteSessionTurnResultV1>((settle) => {
      const entry = createEntry(turn, critical, settle);
      this.#pending.push(entry);
      this.#retain(entry);
    });
    this.#scheduleDrain();
    return completion;
  }

  public cancelPendingReplacement(
    kind: NoteSessionTurnKindV1,
    key: string,
  ): boolean {
    const index = this.#pending.findIndex(
      (entry) =>
        entry.turn.kind === kind && entry.turn.replacement?.key === key,
    );
    if (index < 0) return false;
    const [entry] = this.#pending.splice(index, 1);
    if (entry === undefined) return false;
    entry.controller.abort();
    entry.settle(Object.freeze({ kind: "cancelled" }));
    this.#release(entry);
    this.#resolveIdleIfNeeded();
    return true;
  }

  public cancelPendingReplaceableKinds(
    kinds: readonly NoteSessionTurnKindV1[],
  ): number {
    const selected = new Set(kinds);
    let cancelled = 0;
    for (let index = this.#pending.length - 1; index >= 0; index -= 1) {
      const entry = this.#pending[index];
      if (
        entry?.turn.replacement === undefined ||
        !selected.has(entry.turn.kind)
      ) {
        continue;
      }
      this.#pending.splice(index, 1);
      entry.controller.abort();
      entry.settle(Object.freeze({ kind: "cancelled" }));
      this.#release(entry);
      cancelled += 1;
    }
    this.#resolveIdleIfNeeded();
    return cancelled;
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return this.whenIdle();
    this.#disposed = true;
    if (this.#active !== null && !this.#active.critical) {
      this.#active.controller.abort();
    }
    const critical: QueueEntryV1[] = [];
    for (const entry of this.#pending.splice(0)) {
      if (entry.critical) {
        critical.push(entry);
        continue;
      }
      entry.controller.abort();
      entry.settle(Object.freeze({ kind: "cancelled" }));
      this.#release(entry);
    }
    this.#pending.push(...critical);
    this.#scheduleDrain();
    this.#resolveIdleIfNeeded();
    return this.whenIdle();
  }

  public whenIdle(): Promise<void> {
    if (this.#retainedTurns === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }

  #replacePending(
    turn: NoteSessionQueueTurnV1,
  ): Promise<NoteSessionTurnResultV1> | null {
    if (turn.replacement === undefined) return null;
    const index = this.#pending.findIndex(
      (entry) =>
        entry.turn.kind === turn.kind &&
        entry.turn.replacement?.key === turn.replacement?.key,
    );
    if (index < 0) return null;
    const prior = this.#pending[index];
    if (prior === undefined) return null;
    const priorRevision = prior.turn.replacement?.revision ?? 0;
    if (turn.replacement.revision <= priorRevision) {
      return Promise.resolve(Object.freeze({ kind: "superseded" }));
    }
    if (!this.#fitsReplacement(prior, turn)) {
      return immediateRejection("resource-limit");
    }
    let settleReplacement: (result: NoteSessionTurnResultV1) => void =
      missingSettlement;
    const completion = new Promise<NoteSessionTurnResultV1>((settle) => {
      settleReplacement = settle;
    });
    const replacement = createEntry(turn, prior.critical, settleReplacement);
    this.#pending[index] = replacement;
    this.#replaceRetention(prior, replacement);
    prior.controller.abort();
    prior.settle(Object.freeze({ kind: "replaced" }));
    return completion;
  }

  #fits(turn: NoteSessionQueueTurnV1, critical: boolean): boolean {
    if (
      this.#retainedTurns >= this.#limits.maxTurns ||
      this.#retainedBytes + turn.retainedBytes > this.#limits.maxRetainedBytes
    ) {
      return false;
    }
    if (critical) return true;
    return (
      this.#ordinaryTurns <
        this.#limits.maxTurns - this.#limits.reservedCriticalTurns &&
      this.#ordinaryBytes + turn.retainedBytes <=
        this.#limits.maxRetainedBytes - this.#limits.reservedCriticalBytes
    );
  }

  #fitsReplacement(
    prior: QueueEntryV1,
    replacement: NoteSessionQueueTurnV1,
  ): boolean {
    const retainedBytes =
      this.#retainedBytes -
      prior.turn.retainedBytes +
      replacement.retainedBytes;
    if (retainedBytes > this.#limits.maxRetainedBytes) return false;
    if (prior.critical) return true;
    const ordinaryBytes =
      this.#ordinaryBytes -
      prior.turn.retainedBytes +
      replacement.retainedBytes;
    return (
      ordinaryBytes <=
      this.#limits.maxRetainedBytes - this.#limits.reservedCriticalBytes
    );
  }

  #scheduleDrain(): void {
    if (this.#scheduled || this.#active !== null) return;
    this.#scheduled = true;
    this.#schedule(() => {
      this.#scheduled = false;
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#active !== null) return;
    while (this.#pending.length > 0) {
      const entry = this.#pending.shift();
      if (entry === undefined) break;
      this.#active = entry;
      const result = await this.#run(entry);
      this.#active = null;
      this.#release(entry);
      entry.settle(result);
    }
    this.#resolveIdleIfNeeded();
  }

  async #run(entry: QueueEntryV1): Promise<NoteSessionTurnResultV1> {
    const aborted = new Promise<"cancelled">((resolve) => {
      entry.controller.signal.addEventListener(
        "abort",
        () => resolve("cancelled"),
        { once: true },
      );
    });
    try {
      const execution = Promise.resolve(
        entry.turn.run(entry.controller.signal),
      );
      const outcome = await Promise.race([
        execution.then(() => "completed" as const),
        aborted,
      ]);
      return Object.freeze({ kind: outcome });
    } catch (error: unknown) {
      return entry.controller.signal.aborted
        ? Object.freeze({ kind: "cancelled" })
        : Object.freeze({ error, kind: "failed" });
    }
  }

  #retain(entry: QueueEntryV1): void {
    this.#retainedTurns += 1;
    this.#retainedBytes += entry.turn.retainedBytes;
    if (entry.critical) return;
    this.#ordinaryTurns += 1;
    this.#ordinaryBytes += entry.turn.retainedBytes;
  }

  #release(entry: QueueEntryV1): void {
    this.#retainedTurns -= 1;
    this.#retainedBytes -= entry.turn.retainedBytes;
    if (!entry.critical) {
      this.#ordinaryTurns -= 1;
      this.#ordinaryBytes -= entry.turn.retainedBytes;
    }
    this.#capacity.release(entry.critical);
  }

  #replaceRetention(prior: QueueEntryV1, replacement: QueueEntryV1): void {
    const byteDelta = replacement.turn.retainedBytes - prior.turn.retainedBytes;
    this.#retainedBytes += byteDelta;
    if (!prior.critical) this.#ordinaryBytes += byteDelta;
  }

  #resolveIdleIfNeeded(): void {
    if (this.#retainedTurns !== 0) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}

function createEntry(
  turn: NoteSessionQueueTurnV1,
  critical: boolean,
  settle: (result: NoteSessionTurnResultV1) => void,
): QueueEntryV1 {
  return { controller: new AbortController(), critical, settle, turn };
}

function immediateRejection(
  reason: "disposed" | "resource-limit",
): Promise<NoteSessionTurnResultV1> {
  return Promise.resolve(Object.freeze({ kind: "rejected", reason }));
}

function missingSettlement(): never {
  throw new Error("A queue settlement callback was not initialized.");
}

function isCritical(kind: NoteSessionTurnKindV1): boolean {
  return (
    kind === "history" ||
    kind === "lifecycle" ||
    kind === "recovery-acknowledgement"
  );
}

function validateLimits(limits: NoteSessionQueueLimitsV1): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("Queue limits must be non-negative safe integers.");
    }
  }
  if (
    limits.maxTurns === 0 ||
    limits.maxRetainedBytes === 0 ||
    limits.reservedCriticalTurns > limits.maxTurns ||
    limits.reservedCriticalBytes > limits.maxRetainedBytes
  ) {
    throw new RangeError("Queue reserve limits must fit their total limits.");
  }
}

function validateTurn(turn: NoteSessionQueueTurnV1): void {
  if (!Number.isSafeInteger(turn.retainedBytes) || turn.retainedBytes < 0) {
    throw new RangeError("A queue turn has invalid retained bytes.");
  }
  if (turn.replacement === undefined) return;
  if (!REPLACEABLE_KINDS.has(turn.kind)) {
    throw new TypeError("This queue turn kind cannot replace pending work.");
  }
  if (
    turn.replacement.key.length === 0 ||
    !Number.isSafeInteger(turn.replacement.revision) ||
    turn.replacement.revision <= 0
  ) {
    throw new TypeError("A replacement turn has an invalid key or revision.");
  }
}
