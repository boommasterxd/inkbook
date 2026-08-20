import { commandFailure, commandSuccess } from "../note-session/results";
import type { CommandResultV1 } from "../note-session/types";
import {
  sameNoteIdentity,
  sameSidecarBase,
  validateRemovalRecord,
  type ActiveRemovalRecoveryV1,
  type RecoveryStore,
  type RemovalRecordV1,
  type SidecarBaseIdentityV1,
} from "../recovery";

export const REMOVAL_BARRIER_TIMEOUT_MS_V1 = 2000;

type AsyncResult = Promise<CommandResultV1<void>>;

export interface RemovalClockV1 {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RemovalPortsV1 {
  trashSidecar(record: RemovalRecordV1): Promise<void>;
  removeMarker(record: RemovalRecordV1): AsyncResult;
  clearSession(record: RemovalRecordV1): AsyncResult;
  resolveFailure(record: RemovalRecordV1): AsyncResult;
  handleExternalDelete(sidecarBase: SidecarBaseIdentityV1): AsyncResult;
}

export interface RemovalDeleteEventV1 {
  readonly sidecarBase: SidecarBaseIdentityV1;
}

export interface RemovalDeleteEventResultV1 {
  readonly consumed: boolean;
  readonly reason: "accepted" | "duplicate" | "inactive" | "mismatch";
}

export interface BeginRemovalRequestV1 {
  readonly record: RemovalRecordV1;
  readonly recovery: RecoveryStore;
  readonly ports: RemovalPortsV1;
  readonly clock: RemovalClockV1;
}

export interface ResumeRemovalRequestV1 {
  readonly activeRecovery: ActiveRemovalRecoveryV1;
  readonly recovery: RecoveryStore;
  readonly ports: RemovalPortsV1;
  readonly clock: RemovalClockV1;
}

export async function beginAnnotationRemoval(
  request: BeginRemovalRequestV1,
): Promise<CommandResultV1<AnnotationRemovalCoordinatorV1>> {
  return AnnotationRemovalCoordinatorV1.begin(request);
}

export async function resumeAnnotationRemovalV1(
  request: ResumeRemovalRequestV1,
): Promise<CommandResultV1<AnnotationRemovalCoordinatorV1>> {
  return AnnotationRemovalCoordinatorV1.resume(request);
}

export class AnnotationRemovalCoordinatorV1 {
  readonly #recovery: RecoveryStore;
  readonly #ports: RemovalPortsV1;
  readonly #clock: RemovalClockV1;
  readonly #activeRecovery: ActiveRemovalRecoveryV1;
  #record: RemovalRecordV1;
  #timer: unknown = undefined;
  #tail: Promise<void> = Promise.resolve();
  #trashTask: Promise<unknown> = Promise.resolve();
  #active = true;
  #completed = false;

  private constructor(
    recovery: RecoveryStore,
    ports: RemovalPortsV1,
    clock: RemovalClockV1,
    activeRecovery: ActiveRemovalRecoveryV1,
  ) {
    this.#record = activeRecovery.removal;
    this.#recovery = recovery;
    this.#ports = ports;
    this.#clock = clock;
    this.#activeRecovery = activeRecovery;
  }

  public static async begin(
    request: BeginRemovalRequestV1,
  ): Promise<CommandResultV1<AnnotationRemovalCoordinatorV1>> {
    const now = request.clock.now();
    if (
      !Number.isSafeInteger(now) ||
      request.record.deadlineEpochMs !== now + REMOVAL_BARRIER_TIMEOUT_MS_V1
    ) {
      return commandFailure("invalid-command");
    }
    const started = await invoke(() =>
      request.recovery.beginRemoval(request.record),
    );
    if (!started.ok) return started;
    if (request.clock.now() >= request.record.deadlineEpochMs) {
      await invoke(() => request.ports.resolveFailure(request.record));
      return commandFailure("sidecar-drift");
    }
    const activeRecovery = await invoke(() =>
      request.recovery.loadActiveRemoval({
        noteIdentity: request.record.noteIdentity,
      }),
    );
    if (
      !activeRecovery.ok ||
      activeRecovery.value === null ||
      !sameRemovalRecord(activeRecovery.value.removal, request.record)
    ) {
      await invoke(() => request.ports.resolveFailure(request.record));
      return activeRecovery.ok
        ? commandFailure("sidecar-conflict")
        : activeRecovery;
    }
    if (request.clock.now() >= request.record.deadlineEpochMs) {
      await invoke(() => request.ports.resolveFailure(request.record));
      return commandFailure("sidecar-drift");
    }
    const coordinator = new AnnotationRemovalCoordinatorV1(
      request.recovery,
      request.ports,
      request.clock,
      activeRecovery.value,
    );
    coordinator.invokeTrash();
    return commandSuccess(coordinator);
  }

  public static async resume(
    request: ResumeRemovalRequestV1,
  ): Promise<CommandResultV1<AnnotationRemovalCoordinatorV1>> {
    const record = request.activeRecovery.removal;
    const now = request.clock.now();
    if (!Number.isSafeInteger(now) || !validDurableRemovalState(record)) {
      return commandFailure("invalid-command");
    }
    if (now >= record.deadlineEpochMs) {
      await invoke(() => request.ports.resolveFailure(record));
      return commandFailure("sidecar-drift");
    }
    const coordinator = new AnnotationRemovalCoordinatorV1(
      request.recovery,
      request.ports,
      request.clock,
      request.activeRecovery,
    );
    coordinator.resumeExisting();
    return commandSuccess(coordinator);
  }

  public acceptDeleteEvent(
    event: RemovalDeleteEventV1,
  ): Promise<RemovalDeleteEventResultV1> {
    return this.enqueue(() => this.handleDeleteEvent(event));
  }

  public retryCleanup(): AsyncResult {
    return this.enqueue(async () => {
      if (!this.#active) return commandFailure("disposed");
      return this.finishBarrier();
    });
  }

  public async whenIdle(): Promise<void> {
    await this.#trashTask;
    await this.#tail;
  }

  public dispose(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.#active) return;
      await this.invalidate(true);
    });
  }

  private invokeTrash(): void {
    this.armTimer();
    this.invokeTrashTask();
  }

  private resumeExisting(): void {
    this.armTimer();
    if (!this.#record.trashAcknowledged) {
      this.invokeTrashTask();
      return;
    }
    if (this.#record.deleteEventAcknowledged) {
      this.#trashTask = this.enqueue(() => this.finishBarrier());
    }
  }

  private armTimer(): void {
    if (this.#timer !== undefined) return;
    const remainingMs = Math.max(
      0,
      this.#record.deadlineEpochMs - this.#clock.now(),
    );
    this.#timer = this.#clock.setTimeout(() => {
      void this.enqueue(() => this.expire());
    }, remainingMs);
  }

  private invokeTrashTask(): void {
    this.#trashTask = Promise.resolve()
      .then(() => this.#ports.trashSidecar(this.#record))
      .then(
        () => this.enqueue(() => this.acknowledgeTrash()),
        () => this.enqueue(() => this.rejectTrash()),
      );
    void this.#trashTask;
  }

  private async handleDeleteEvent(
    event: RemovalDeleteEventV1,
  ): Promise<RemovalDeleteEventResultV1> {
    if (!sameSidecarBase(event.sidecarBase, this.#record.sidecarBase)) {
      if (this.#active) await this.invalidate(false);
      await invoke(() => this.#ports.handleExternalDelete(event.sidecarBase));
      return eventResult(false, "mismatch");
    }
    if (this.#completed) return eventResult(false, "duplicate");
    if (!this.#active) {
      await invoke(() => this.#ports.handleExternalDelete(event.sidecarBase));
      return eventResult(false, "inactive");
    }
    if (this.expired()) {
      await this.invalidate(false);
      await invoke(() => this.#ports.handleExternalDelete(event.sidecarBase));
      return eventResult(false, "inactive");
    }
    if (this.#record.deleteEventAcknowledged) {
      return eventResult(false, "duplicate");
    }
    const advanced = await this.advance({ deleteEventAcknowledged: true });
    if (!advanced.ok) return eventResult(false, "inactive");
    await this.finishBarrier();
    return eventResult(true, "accepted");
  }

  private async acknowledgeTrash(): AsyncResult {
    if (!this.#active) return commandFailure("sidecar-drift");
    if (this.expired()) {
      await this.invalidate(false);
      return commandFailure("sidecar-drift");
    }
    if (this.#record.trashAcknowledged) return commandSuccess(undefined);
    const advanced = await this.advance({ trashAcknowledged: true });
    if (!advanced.ok) return advanced;
    return this.finishBarrier();
  }

  private async rejectTrash(): AsyncResult {
    if (!this.#active) return commandFailure("sidecar-drift");
    await this.invalidate(false);
    return commandFailure("sidecar-drift");
  }

  private async expire(): AsyncResult {
    if (!this.#active || this.#completed) return commandSuccess(undefined);
    await this.invalidate(false);
    return commandFailure("sidecar-drift");
  }

  private async finishBarrier(): AsyncResult {
    if (
      !this.#record.trashAcknowledged ||
      !this.#record.deleteEventAcknowledged
    ) {
      return commandSuccess(undefined);
    }
    this.clearTimer();
    if (this.#record.markerState !== "removed") {
      if (this.#record.markerState === "present") {
        const removing = await this.advanceMarker("removing");
        if (!removing.ok) return removing;
      }
      const marker = await invoke(() => this.#ports.removeMarker(this.#record));
      if (!marker.ok) return marker;
      const removed = await this.advanceMarker("removed");
      if (!removed.ok) return removed;
    }
    const completed = await clearRemovalState(
      this.#record,
      this.#activeRecovery,
      this.#recovery,
      this.#ports,
    );
    if (completed.ok) {
      this.#completed = true;
      this.#active = false;
    }
    return completed;
  }

  private async advance(
    change:
      | Pick<RemovalRecordV1, "trashAcknowledged">
      | Pick<RemovalRecordV1, "deleteEventAcknowledged">,
  ): AsyncResult {
    const replacement = { ...this.#record, ...change };
    const result = await invoke(() =>
      this.#recovery.advanceRemoval({ expected: this.#record, replacement }),
    );
    if (result.ok) this.#record = replacement;
    else await this.invalidate(false);
    return result;
  }

  private async advanceMarker(
    markerState: RemovalRecordV1["markerState"],
  ): AsyncResult {
    const replacement = { ...this.#record, markerState };
    const result = await invoke(() =>
      this.#recovery.advanceRemoval({ expected: this.#record, replacement }),
    );
    if (result.ok) this.#record = replacement;
    else await this.invalidate(false);
    return result;
  }

  private async invalidate(disposed: boolean): Promise<void> {
    if (!this.#active) return;
    this.#active = false;
    this.clearTimer();
    await invoke(() => this.#ports.resolveFailure(this.#record));
    if (disposed) this.#completed = false;
  }

  private expired(): boolean {
    return this.#clock.now() >= this.#record.deadlineEpochMs;
  }

  private clearTimer(): void {
    if (this.#timer === undefined) return;
    this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task, task);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function validDurableRemovalState(record: RemovalRecordV1): boolean {
  return (
    validateRemovalRecord(record).ok &&
    (record.markerState === "present" ||
      (record.trashAcknowledged && record.deleteEventAcknowledged))
  );
}

function sameRemovalRecord(
  left: RemovalRecordV1,
  right: RemovalRecordV1,
): boolean {
  return (
    left.removalId === right.removalId &&
    sameNoteIdentity(left.noteIdentity, right.noteIdentity) &&
    sameSidecarBase(left.sidecarBase, right.sidecarBase) &&
    left.expectedSceneRevision === right.expectedSceneRevision &&
    left.deadlineEpochMs === right.deadlineEpochMs &&
    left.trashAcknowledged === right.trashAcknowledged &&
    left.deleteEventAcknowledged === right.deleteEventAcknowledged &&
    left.markerState === right.markerState
  );
}

async function clearRemovalState(
  record: RemovalRecordV1,
  activeRecovery: ActiveRemovalRecoveryV1,
  recovery: RecoveryStore,
  ports: RemovalPortsV1,
): AsyncResult {
  const session = await invoke(() => ports.clearSession(record));
  if (!session.ok) return session;
  return invoke(() =>
    recovery.finalizeRemovalRecovery({
      expectedAttempts: activeRecovery.attempts,
      expectedCheckpoints: activeRecovery.checkpoints,
      expectedRemoval: record,
    }),
  );
}

function eventResult(
  consumed: boolean,
  reason: RemovalDeleteEventResultV1["reason"],
): RemovalDeleteEventResultV1 {
  return Object.freeze({ consumed, reason });
}

async function invoke<T>(
  action: () => Promise<CommandResultV1<T>>,
): Promise<CommandResultV1<T>> {
  try {
    return await action();
  } catch {
    return commandFailure("recovery-unavailable");
  }
}
