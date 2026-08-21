import { commandFailure, commandSuccess } from "./results";
import type { NoteSessionQueueCapacityV1 } from "./queue";
import type { NoteSessionIdentityRekeyHandleV1 } from "./identity-rekey";
import type { NoteSessionV1 } from "./session";
import type { CommandResultV1, NoteIdentityV1, ViewId } from "./types";

export interface NoteSessionRegistryLimitsV1 {
  readonly maxSessions: number;
  readonly maxQueuedTurns: number;
  readonly reservedCriticalTurns: number;
}

export interface NoteSessionRegistryConfigV1 {
  readonly limits: NoteSessionRegistryLimitsV1;
  readonly createSession: (
    identity: NoteIdentityV1,
    capacity: NoteSessionQueueCapacityV1,
  ) => NoteSessionV1;
}

export interface NoteSessionReferenceV1 {
  readonly session: NoteSessionV1;
  readonly viewId: ViewId;
  release(options?: NoteSessionReleaseOptionsV1): Promise<void>;
}

export interface NoteSessionReleaseOptionsV1 {
  readonly hostEffectsAreUnreachable: boolean;
}

export interface NoteSessionIdentityRekeyV1 {
  readonly prior: NoteIdentityV1;
  readonly replacement: NoteIdentityV1;
}

interface RegistryEntryV1 {
  identity: NoteIdentityV1;
  key: string;
  readonly session: NoteSessionV1;
  references: number;
}

interface PlannedIdentityRekeyV1 extends NoteSessionIdentityRekeyV1 {
  readonly entry: RegistryEntryV1;
  readonly keys: RekeyKeysV1;
}

export class NoteSessionRegistryV1 {
  readonly #config: NoteSessionRegistryConfigV1;
  readonly #entries = new Map<string, RegistryEntryV1>();
  readonly #rekeyReservations = new Set<string>();
  readonly #capacity: NoteSessionQueueCapacityV1;
  #queuedTurns = 0;
  #ordinaryQueuedTurns = 0;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  public constructor(config: NoteSessionRegistryConfigV1) {
    validateLimits(config.limits);
    this.#config = config;
    this.#capacity = {
      release: (critical): void => this.#releaseTurn(critical),
      tryReserve: (critical): boolean => this.#reserveTurn(critical),
    };
  }

  public get sessionCount(): number {
    return this.#entries.size;
  }

  public get queuedTurnCount(): number {
    return this.#queuedTurns;
  }

  public acquire(
    identity: NoteIdentityV1,
    viewId: ViewId,
  ): CommandResultV1<NoteSessionReferenceV1> {
    if (this.#disposed) return commandFailure("disposed");
    const key = identityKey(identity);
    if (this.#rekeyReservations.has(key)) {
      return commandFailure("relocation-pending");
    }
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      if (this.#entries.size >= this.#config.limits.maxSessions) {
        return commandFailure("resource-limit");
      }
      const frozenIdentity = freezeIdentity(identity);
      entry = {
        identity: frozenIdentity,
        key,
        references: 0,
        session: this.#config.createSession(frozenIdentity, this.#capacity),
      };
      this.#entries.set(key, entry);
    }
    entry.references += 1;
    entry.session.readmitOverlay(entry.identity);
    return commandSuccess(this.#createReference(entry, viewId));
  }

  public referenceCount(identity: NoteIdentityV1): number {
    return this.#entries.get(identityKey(identity))?.references ?? 0;
  }

  public identitiesWithinPrefix(prefix: string): readonly NoteIdentityV1[] {
    const normalized = prefix.replace(/\/$/, "");
    if (normalized.length === 0 || normalized.includes("\0")) {
      return Object.freeze([]);
    }
    return Object.freeze(
      [...this.#entries.values()]
        .map((entry) => entry.identity)
        .filter((identity) => pathIsWithin(identity, normalized)),
    );
  }

  public async rekey(
    prior: NoteIdentityV1,
    replacement: NoteIdentityV1,
  ): Promise<CommandResultV1<void>> {
    return this.rekeyBatch([{ prior, replacement }]);
  }

  public async rekeyBatch(
    rekeys: readonly NoteSessionIdentityRekeyV1[],
  ): Promise<CommandResultV1<void>> {
    if (this.#disposed) return commandFailure("disposed");
    const plan = this.#planRekeyBatch(rekeys);
    if (!plan.ok) return plan;
    if (plan.value.length === 0) return commandSuccess(undefined);
    if (!this.#reserveRekeyBatch(plan.value)) {
      return commandFailure("relocation-pending");
    }
    const handles = plan.value.map((item) =>
      item.entry.session.stageNoteIdentityRekey(item.prior, item.replacement),
    );
    try {
      return await this.#executeRekeyBatch(plan.value, handles);
    } finally {
      this.#releaseRekeyBatch(plan.value);
    }
  }

  public suspendOverlay(identity: NoteIdentityV1): boolean {
    const entry = this.#entries.get(identityKey(identity));
    if (entry === undefined) return false;
    entry.session.suspendOverlay();
    return true;
  }

  public readmitOverlay(identity: NoteIdentityV1): boolean {
    const entry = this.#entries.get(identityKey(identity));
    return entry?.session.readmitOverlay(identity) ?? false;
  }

  public dispose(hostEffectsMayBeReachable: boolean): Promise<void> {
    if (this.#disposePromise !== null) return this.#disposePromise;
    this.#disposed = true;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    this.#disposePromise = Promise.all(
      entries.map((entry) => entry.session.dispose(hostEffectsMayBeReachable)),
    ).then(() => undefined);
    return this.#disposePromise;
  }

  #createReference(
    entry: RegistryEntryV1,
    viewId: ViewId,
  ): NoteSessionReferenceV1 {
    let releasePromise: Promise<void> | null = null;
    return Object.freeze({
      release: (options?: NoteSessionReleaseOptionsV1): Promise<void> => {
        releasePromise ??= this.#releaseReference(entry, viewId, options);
        return releasePromise;
      },
      session: entry.session,
      viewId,
    });
  }

  #releaseReference(
    entry: RegistryEntryV1,
    viewId: ViewId,
    options: NoteSessionReleaseOptionsV1 | undefined,
  ): Promise<void> {
    if (this.#entries.get(entry.key) !== entry || entry.references === 0) {
      return Promise.resolve();
    }
    entry.references -= 1;
    const hostEffectsAreUnreachable =
      options?.hostEffectsAreUnreachable ?? false;
    const closeOwner =
      entry.session.snapshot.historyLease.kind === "owned" &&
      entry.session.snapshot.historyLease.ownerViewId === viewId
        ? entry.session.closeOwner(viewId, hostEffectsAreUnreachable)
        : Promise.resolve();
    return closeOwner.then(async () => {
      if (entry.references > 0) return;
      const result = await entry.session.beginHeadlessFlush();
      if (
        result === "readmitted" ||
        this.#entries.get(entry.key) !== entry ||
        entry.references > 0 ||
        (entry.session.snapshot.historyLease.kind === "blocked" &&
          !hostEffectsAreUnreachable)
      ) {
        return;
      }
      await entry.session.dispose(false);
      if (this.#entries.get(entry.key) === entry && entry.references === 0) {
        this.#entries.delete(entry.key);
      }
    });
  }

  #reserveTurn(critical: boolean): boolean {
    if (
      this.#disposed ||
      this.#queuedTurns >= this.#config.limits.maxQueuedTurns
    ) {
      return false;
    }
    const ordinaryLimit =
      this.#config.limits.maxQueuedTurns -
      this.#config.limits.reservedCriticalTurns;
    if (!critical && this.#ordinaryQueuedTurns >= ordinaryLimit) return false;
    this.#queuedTurns += 1;
    if (!critical) this.#ordinaryQueuedTurns += 1;
    return true;
  }

  #releaseTurn(critical: boolean): void {
    this.#queuedTurns -= 1;
    if (!critical) this.#ordinaryQueuedTurns -= 1;
  }

  #planRekeyBatch(
    rekeys: readonly NoteSessionIdentityRekeyV1[],
  ): CommandResultV1<readonly PlannedIdentityRekeyV1[]> {
    const normalized = normalizeRekeyBatch(
      rekeys,
      this.#config.limits.maxSessions,
    );
    if (!normalized.ok) return normalized;
    const plan: PlannedIdentityRekeyV1[] = [];
    for (const item of normalized.value) {
      const entry = this.#entries.get(item.keys.prior);
      if (entry === undefined) return commandFailure("invalid-command");
      if (this.#entries.has(item.keys.replacement)) {
        return commandFailure("relocation-pending");
      }
      plan.push(Object.freeze({ ...item, entry }));
    }
    return commandSuccess(Object.freeze(plan));
  }

  #reserveRekeyBatch(plan: readonly PlannedIdentityRekeyV1[]): boolean {
    for (const item of plan) {
      if (
        this.#entries.get(item.keys.prior) !== item.entry ||
        this.#entries.has(item.keys.replacement) ||
        this.#rekeyReservations.has(item.keys.prior) ||
        this.#rekeyReservations.has(item.keys.replacement)
      ) {
        return false;
      }
    }
    for (const item of plan) {
      this.#rekeyReservations.add(item.keys.prior);
      this.#rekeyReservations.add(item.keys.replacement);
    }
    return true;
  }

  async #executeRekeyBatch(
    plan: readonly PlannedIdentityRekeyV1[],
    handles: readonly NoteSessionIdentityRekeyHandleV1[],
  ): Promise<CommandResultV1<void>> {
    if (!(await everyHandle(handles, "admitted")) || this.#disposed) {
      cancelHandles(handles);
      const results = await completeHandles(handles);
      return commandFailure(this.#failureCode(results));
    }
    for (const handle of handles) handle.startPreparation();
    if (!(await everyHandle(handles, "prepared"))) {
      cancelHandles(handles);
      await completeHandles(handles);
      return commandFailure("invalid-command");
    }
    for (const handle of handles) handle.startCommit();
    const committed = await everyHandle(handles, "committed");
    if (!committed || !this.#canCommitRekeyBatch(plan)) {
      cancelHandles(handles);
      await completeHandles(handles);
      return commandFailure("invalid-command");
    }
    this.#commitRekeyBatch(plan);
    for (const handle of handles) handle.finish(true);
    await completeHandles(handles);
    return commandSuccess(undefined);
  }

  #canCommitRekeyBatch(plan: readonly PlannedIdentityRekeyV1[]): boolean {
    if (this.#disposed) return false;
    return plan.every(
      (item) =>
        this.#entries.get(item.keys.prior) === item.entry &&
        !this.#entries.has(item.keys.replacement) &&
        this.#rekeyReservations.has(item.keys.prior) &&
        this.#rekeyReservations.has(item.keys.replacement),
    );
  }

  #commitRekeyBatch(plan: readonly PlannedIdentityRekeyV1[]): void {
    for (const item of plan) this.#entries.delete(item.keys.prior);
    for (const item of plan) {
      item.entry.identity = item.replacement;
      item.entry.key = item.keys.replacement;
      this.#entries.set(item.keys.replacement, item.entry);
    }
  }

  #releaseRekeyBatch(plan: readonly PlannedIdentityRekeyV1[]): void {
    for (const item of plan) {
      this.#rekeyReservations.delete(item.keys.prior);
      this.#rekeyReservations.delete(item.keys.replacement);
    }
  }

  #failureCode(
    results: readonly Awaited<NoteSessionIdentityRekeyHandleV1["completion"]>[],
  ): "disposed" | "resource-limit" | "invalid-command" {
    if (this.#disposed) return "disposed";
    const rejected = results.find((result) => result.kind === "rejected");
    return rejected?.kind === "rejected" ? rejected.reason : "invalid-command";
  }
}

interface RekeyKeysV1 {
  readonly prior: string;
  readonly replacement: string;
}

interface NormalizedIdentityRekeyV1 extends NoteSessionIdentityRekeyV1 {
  readonly keys: RekeyKeysV1;
}

function normalizeRekeyBatch(
  rekeys: readonly NoteSessionIdentityRekeyV1[],
  maximum: number,
): CommandResultV1<readonly NormalizedIdentityRekeyV1[]> {
  if (rekeys.length > maximum) return commandFailure("resource-limit");
  const sources = new Set<string>();
  const targets = new Set<string>();
  const normalized: NormalizedIdentityRekeyV1[] = [];
  for (const rekey of rekeys) {
    const keys = resolveRekeyKeys(rekey.prior, rekey.replacement);
    if (
      keys === null ||
      keys.prior === keys.replacement ||
      rekey.prior.vaultIdHint !== rekey.replacement.vaultIdHint ||
      sources.has(keys.prior) ||
      targets.has(keys.replacement)
    ) {
      return commandFailure("invalid-command");
    }
    sources.add(keys.prior);
    targets.add(keys.replacement);
    normalized.push(
      Object.freeze({
        keys,
        prior: freezeIdentity(rekey.prior),
        replacement: freezeIdentity(rekey.replacement),
      }),
    );
  }
  if ([...sources].some((key) => targets.has(key))) {
    return commandFailure("invalid-command");
  }
  return commandSuccess(Object.freeze(normalized));
}

async function everyHandle(
  handles: readonly NoteSessionIdentityRekeyHandleV1[],
  phase: "admitted" | "prepared" | "committed",
): Promise<boolean> {
  const results = await Promise.all(handles.map((handle) => handle[phase]));
  return results.every(Boolean);
}

function cancelHandles(
  handles: readonly NoteSessionIdentityRekeyHandleV1[],
): void {
  for (const handle of handles) handle.cancel();
}

function completeHandles(
  handles: readonly NoteSessionIdentityRekeyHandleV1[],
): Promise<readonly Awaited<NoteSessionIdentityRekeyHandleV1["completion"]>[]> {
  return Promise.all(handles.map((handle) => handle.completion));
}

function resolveRekeyKeys(
  prior: NoteIdentityV1,
  replacement: NoteIdentityV1,
): RekeyKeysV1 | null {
  try {
    return Object.freeze({
      prior: identityKey(prior),
      replacement: identityKey(replacement),
    });
  } catch {
    return null;
  }
}

function pathIsWithin(identity: NoteIdentityV1, prefix: string): boolean {
  const path = identity.vaultRelativeMarkdownPath;
  return path === prefix || path.startsWith(`${prefix}/`);
}

function identityKey(identity: NoteIdentityV1): string {
  validateIdentity(identity);
  return JSON.stringify([
    identity.vaultIdHint,
    identity.vaultRelativeMarkdownPath,
  ]);
}

function freezeIdentity(identity: NoteIdentityV1): NoteIdentityV1 {
  validateIdentity(identity);
  return Object.freeze({ ...identity });
}

function validateIdentity(identity: NoteIdentityV1): void {
  if (
    identity.vaultIdHint.length === 0 ||
    identity.vaultRelativeMarkdownPath.length === 0 ||
    identity.vaultIdHint.includes("\0") ||
    identity.vaultRelativeMarkdownPath.includes("\0")
  ) {
    throw new TypeError("The resolved note identity is invalid.");
  }
}

function validateLimits(limits: NoteSessionRegistryLimitsV1): void {
  if (
    !Number.isSafeInteger(limits.maxSessions) ||
    !Number.isSafeInteger(limits.maxQueuedTurns) ||
    !Number.isSafeInteger(limits.reservedCriticalTurns) ||
    limits.maxSessions <= 0 ||
    limits.maxQueuedTurns <= 0 ||
    limits.reservedCriticalTurns < 0 ||
    limits.reservedCriticalTurns > limits.maxQueuedTurns
  ) {
    throw new RangeError("The note session registry limits are invalid.");
  }
}
