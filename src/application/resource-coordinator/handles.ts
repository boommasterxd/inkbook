import {
  RESOURCE_CATEGORIES_V1,
  type AsyncResourceHandleV1,
  type BatchResourceHandleV1,
  type EmergencyTurnHandleV1,
  type EmergencyTurnKindV1,
  type ResourceAdmissionFailureReasonV1,
  type ResourceAdmissionHandleV1,
  type ResourceAdmissionResultV1,
  type ResourceChargeV1,
  type ResourceCategoryV1,
  type SessionResourceHandleV1,
} from "./types";
import type { LedgerEntry } from "./ledger";

export interface LedgerHandlePort {
  activateHandle(entry: LedgerEntry): boolean;
  releaseHandle(entry: LedgerEntry): boolean;
  transferHandle(entry: LedgerEntry, ownerId: string): boolean;
}

export function createAdmissionHandle(
  port: LedgerHandlePort,
  entry: LedgerEntry,
): ResourceAdmissionHandleV1 {
  return new AdmissionHandle(port, entry);
}

export function createAsyncHandle(
  operation: ResourceAdmissionHandleV1,
  completion: ResourceAdmissionHandleV1,
): AsyncResourceHandleV1 {
  return new BatchHandle([operation], completion);
}

export function createBatchHandle(
  operations: readonly ResourceAdmissionHandleV1[],
  completion?: ResourceAdmissionHandleV1,
): BatchResourceHandleV1 {
  return new BatchHandle(operations, completion);
}

export function createSessionHandle(
  sessionId: string,
  emergencyBytes: number,
  handles: readonly [
    ResourceAdmissionHandleV1,
    ResourceAdmissionHandleV1,
    ResourceAdmissionHandleV1,
  ],
  reject: EmergencyRejection,
): SessionResourceHandleV1 {
  return new SessionHandle(sessionId, emergencyBytes, handles, reject);
}

type EmergencyRejection = (
  category: ResourceCategoryV1,
  charge: ResourceChargeV1,
  reason: ResourceAdmissionFailureReasonV1,
) => ResourceAdmissionResultV1<EmergencyTurnHandleV1>;

class AdmissionHandle implements ResourceAdmissionHandleV1 {
  public constructor(
    private readonly port: LedgerHandlePort,
    private readonly entry: LedgerEntry,
  ) {}

  public get bytes(): number {
    return this.entry.request.bytes;
  }
  public get category(): ResourceCategoryV1 {
    return this.entry.request.category;
  }
  public get count(): number {
    return this.entry.request.count;
  }
  public get ownerId(): string {
    return this.entry.ownerId;
  }
  public get state(): "reserved" | "current" | "released" {
    return this.entry.state;
  }
  public activate(): boolean {
    return this.port.activateHandle(this.entry);
  }
  public release(): boolean {
    return this.port.releaseHandle(this.entry);
  }
  public transfer(ownerId: string): boolean {
    return this.port.transferHandle(this.entry, ownerId);
  }
}

class BatchHandle implements BatchResourceHandleV1 {
  public constructor(
    private readonly operations: readonly ResourceAdmissionHandleV1[],
    private readonly completion?: ResourceAdmissionHandleV1,
  ) {}

  public get state(): BatchResourceHandleV1["state"] {
    if (this.completion?.state === "current") return "completion";
    if (this.operations.every(({ state }) => state === "released")) {
      return "released";
    }
    if (this.operations.every(({ state }) => state === "current")) {
      return "active";
    }
    return "reserved";
  }
  public activate(): boolean {
    if (!this.operations.every(({ state }) => state === "reserved")) {
      return false;
    }
    return this.operations.every((operation) => operation.activate());
  }
  public publishCompletion(ownerId?: string): boolean {
    if (
      this.completion?.state !== "reserved" ||
      !this.operations.every(({ state }) => state === "current")
    ) {
      return false;
    }
    if (ownerId !== undefined && !this.completion.transfer(ownerId)) {
      return false;
    }
    for (const operation of this.operations) operation.release();
    return this.completion.activate();
  }
  public release(): boolean {
    const wasLive = this.state !== "released";
    for (const operation of this.operations) operation.release();
    this.completion?.release();
    return wasLive;
  }
  public transfer(ownerId: string): boolean {
    if (ownerId.trim().length === 0) return false;
    const operationTransferred = this.operations.every(
      (operation) =>
        operation.state === "released" || operation.transfer(ownerId),
    );
    const completionTransferred =
      this.completion === undefined ||
      this.completion.state === "released" ||
      this.completion.transfer(ownerId);
    return operationTransferred && completionTransferred;
  }
}

class SessionHandle implements SessionResourceHandleV1 {
  readonly #busy = new Set<EmergencyTurnKindV1>();
  readonly #session: ResourceAdmissionHandleV1;
  readonly #lifecycle: ResourceAdmissionHandleV1;
  readonly #history: ResourceAdmissionHandleV1;

  public constructor(
    public readonly sessionId: string,
    private readonly emergencyBytes: number,
    handles: readonly [
      ResourceAdmissionHandleV1,
      ResourceAdmissionHandleV1,
      ResourceAdmissionHandleV1,
    ],
    private readonly reject: EmergencyRejection,
  ) {
    [this.#session, this.#lifecycle, this.#history] = handles;
  }

  public get released(): boolean {
    return this.#session.state === "released";
  }
  public admitEmergency(
    kind: EmergencyTurnKindV1,
    payloadBytes: number,
    ownerId = this.sessionId,
  ): ResourceAdmissionResultV1<EmergencyTurnHandleV1> {
    const category = emergencyCategory(kind);
    const charge = { bytes: payloadBytes, count: 1 };
    if (
      this.released ||
      !Number.isSafeInteger(payloadBytes) ||
      payloadBytes < 0 ||
      ownerId.trim().length === 0
    ) {
      return this.reject(category, charge, "invalid-request");
    }
    if (payloadBytes > this.emergencyBytes) {
      return this.reject(category, charge, "emergency-payload-limit");
    }
    if (this.#busy.has(kind)) {
      return this.reject(category, charge, "emergency-slot-busy");
    }
    this.#busy.add(kind);
    return Object.freeze({
      kind: "admitted",
      handle: new EmergencyHandle(
        kind,
        ownerId,
        () => this.#busy.delete(kind),
        () => this.released,
      ),
    });
  }
  public release(): boolean {
    if (this.released) return false;
    this.#busy.clear();
    this.#session.release();
    this.#lifecycle.release();
    this.#history.release();
    return true;
  }
}

class EmergencyHandle implements EmergencyTurnHandleV1 {
  #released = false;
  #ownerId: string;

  public constructor(
    public readonly kind: EmergencyTurnKindV1,
    ownerId: string,
    private readonly onRelease: () => void,
    private readonly isParentReleased: () => boolean,
  ) {
    this.#ownerId = ownerId;
  }
  public get ownerId(): string {
    return this.#ownerId;
  }
  public get released(): boolean {
    return this.#released || this.isParentReleased();
  }
  public release(): boolean {
    if (this.released) return false;
    this.#released = true;
    this.onRelease();
    return true;
  }
  public transfer(ownerId: string): boolean {
    if (this.released || ownerId.trim().length === 0) return false;
    this.#ownerId = ownerId;
    return true;
  }
}

function emergencyCategory(kind: EmergencyTurnKindV1): ResourceCategoryV1 {
  return kind === "lifecycle"
    ? RESOURCE_CATEGORIES_V1.lifecycleEmergency
    : RESOURCE_CATEGORIES_V1.hostHistoryEmergency;
}
