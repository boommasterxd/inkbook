import type { WorkerJob, WorkerJobKind } from "./protocol";

export type QueueAdmission = "accepted" | "busy" | "duplicate" | "full";

export interface WorkerJobQueueOptions {
  readonly requiredCapacity?: number;
}

const PRIORITY: Readonly<Record<WorkerJobKind, number>> = {
  unlock: 0,
  required: 1,
  clipboard: 2,
  export: 3,
};

export class WorkerJobQueue<TPayload> {
  readonly #requiredCapacity: number;
  #active: WorkerJob<TPayload> | null = null;
  readonly #required: WorkerJob<TPayload>[] = [];
  #clipboard: WorkerJob<TPayload> | null = null;
  #export: WorkerJob<TPayload> | null = null;
  #unlock: WorkerJob<TPayload> | null = null;

  public constructor(options: WorkerJobQueueOptions = {}) {
    const requiredCapacity = options.requiredCapacity ?? 4;
    if (!Number.isSafeInteger(requiredCapacity) || requiredCapacity < 1) {
      throw new RangeError("requiredCapacity must be a positive safe integer.");
    }
    this.#requiredCapacity = requiredCapacity;
  }

  public get active(): WorkerJob<TPayload> | null {
    return this.#active;
  }

  public get pendingCount(): number {
    return (
      this.#required.length +
      Number(this.#clipboard !== null) +
      Number(this.#export !== null) +
      Number(this.#unlock !== null)
    );
  }

  public admit(job: WorkerJob<TPayload>): QueueAdmission {
    if (this.#contains(job.id)) {
      return "duplicate";
    }
    if (job.kind === "unlock") {
      return this.#admitUnlock(job);
    }
    if (job.kind === "required") {
      return this.#admitRequired(job);
    }
    if (job.kind === "clipboard") {
      return this.#admitSingle(job, "clipboard");
    }
    return this.#admitSingle(job, "export");
  }

  public complete(
    activeJobId: string,
    eligible: (job: WorkerJob<TPayload>) => boolean = () => true,
  ): WorkerJob<TPayload> | null {
    if (this.#active?.id !== activeJobId) {
      return null;
    }
    this.#active = null;
    return this.startNext(eligible);
  }

  public startNext(
    eligible: (job: WorkerJob<TPayload>) => boolean = () => true,
  ): WorkerJob<TPayload> | null {
    if (this.#active !== null) {
      return this.#active;
    }
    this.#active = this.#takeHighestPriority(eligible);
    return this.#active;
  }

  public clearPending(): readonly WorkerJob<TPayload>[] {
    const pending = this.#orderedPending();
    this.#required.length = 0;
    this.#clipboard = null;
    this.#export = null;
    this.#unlock = null;
    return pending;
  }

  #admitUnlock(job: WorkerJob<TPayload>): QueueAdmission {
    if (this.#active !== null || this.pendingCount > 0) {
      return "busy";
    }
    this.#unlock = job;
    return "accepted";
  }

  #admitRequired(job: WorkerJob<TPayload>): QueueAdmission {
    if (this.#required.length >= this.#requiredCapacity) {
      return "full";
    }
    this.#required.push(job);
    return "accepted";
  }

  #admitSingle(job: WorkerJob<TPayload>, kind: "clipboard" | "export"): QueueAdmission {
    const occupied =
      this.#active?.kind === kind ||
      (kind === "clipboard" ? this.#clipboard : this.#export) !== null;
    if (occupied) {
      return "busy";
    }
    if (kind === "clipboard") {
      this.#clipboard = job;
    } else {
      this.#export = job;
    }
    return "accepted";
  }

  #contains(id: string): boolean {
    return this.#active?.id === id || this.#orderedPending().some((job) => job.id === id);
  }

  #orderedPending(): WorkerJob<TPayload>[] {
    return [
      ...(this.#unlock === null ? [] : [this.#unlock]),
      ...this.#required,
      ...(this.#clipboard === null ? [] : [this.#clipboard]),
      ...(this.#export === null ? [] : [this.#export]),
    ].sort((left, right) => PRIORITY[left.kind] - PRIORITY[right.kind]);
  }

  #takeHighestPriority(
    eligible: (job: WorkerJob<TPayload>) => boolean,
  ): WorkerJob<TPayload> | null {
    if (this.#unlock !== null && eligible(this.#unlock)) {
      const job = this.#unlock;
      this.#unlock = null;
      return job;
    }
    const index = this.#required.findIndex(eligible);
    const required = index === -1 ? undefined : this.#required.splice(index, 1)[0];
    if (required !== undefined) {
      return required;
    }
    if (this.#clipboard !== null && eligible(this.#clipboard)) {
      const job = this.#clipboard;
      this.#clipboard = null;
      return job;
    }
    const job = this.#export;
    if (job === null || !eligible(job)) return null;
    this.#export = null;
    return job;
  }
}
