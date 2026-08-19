import {
  RESOURCE_CATEGORIES_V1,
  type AsyncResourceHandleV1,
  type BatchResourceHandleV1,
  type EmergencyTurnHandleV1,
  type ResourceAdmissionHandleV1,
  type ResourceCoordinatorV1,
  type SessionResourceHandleV1,
} from "../../application/resource-coordinator";
import type { ViewId } from "../../application/host-history";

const KIB = 1_024;
const SESSION_RESIDENT_BYTES = 4_096;
const EDITOR_PROBE_BYTES = 4_096;
const ASYNC_OPERATION_BYTES = 4_096;
const ASYNC_COMPLETION_BYTES = KIB;
const EMERGENCY_DELIVERY_BYTES = 8_192;
const MAX_PENDING_HISTORY_DELIVERIES_V1 = 64;

interface ActionResources {
  readonly prepare: AsyncResourceHandleV1;
  readonly retention: BatchResourceHandleV1;
  delivery: BatchResourceHandleV1 | null;
}

export class PhaseZeroHistoryResourceOwnerV1 {
  readonly #coordinator: ResourceCoordinatorV1;
  readonly #editors = new Map<ViewId, ResourceAdmissionHandleV1>();
  readonly #sessions = new Map<string, PhaseZeroHistorySessionResourcesV1>();
  #disposed = false;

  public constructor(coordinator: ResourceCoordinatorV1) {
    this.#coordinator = coordinator;
  }

  public admitEditorProbe(editorViewId: ViewId): boolean {
    if (this.#disposed || this.#editors.has(editorViewId)) return false;
    const admitted = this.#coordinator.admit({
      bytes: EDITOR_PROBE_BYTES,
      category: RESOURCE_CATEGORIES_V1.subscription,
      count: 1,
      ownerId: editorViewId,
      residency: "steady",
      scope: { id: editorViewId, kind: "view" },
    });
    if (admitted.kind !== "admitted") return false;
    admitted.handle.activate();
    this.#editors.set(editorViewId, admitted.handle);
    return true;
  }

  public releaseEditorProbe(editorViewId: ViewId): boolean {
    const handle = this.#editors.get(editorViewId);
    if (handle === undefined) return false;
    this.#editors.delete(editorViewId);
    return handle.release();
  }

  public admitSession(path: string): PhaseZeroHistorySessionResourcesV1 | null {
    if (this.#disposed || this.#sessions.has(path)) return null;
    const sessionId = `history-session:${path}`;
    const admitted = this.#coordinator.admitSession(
      sessionId,
      SESSION_RESIDENT_BYTES,
    );
    if (admitted.kind !== "admitted") return null;
    const resources = new PhaseZeroHistorySessionResourcesV1(
      this.#coordinator,
      admitted.handle,
    );
    this.#sessions.set(path, resources);
    return resources;
  }

  public releaseSession(path: string): boolean {
    const resources = this.#sessions.get(path);
    if (resources === undefined) return false;
    this.#sessions.delete(path);
    return resources.release();
  }

  public dispose(): boolean {
    if (this.#disposed) return false;
    this.#disposed = true;
    for (const handle of this.#editors.values()) handle.release();
    for (const resources of this.#sessions.values()) resources.release();
    this.#editors.clear();
    this.#sessions.clear();
    return true;
  }
}

export class PhaseZeroHistorySessionResourcesV1 {
  readonly #coordinator: ResourceCoordinatorV1;
  readonly #session: SessionResourceHandleV1;
  readonly #scope: { readonly id: string; readonly kind: "session" };
  readonly #actions = new Map<string, ActionResources>();
  readonly #turns = new Set<BatchResourceHandleV1>();

  public constructor(
    coordinator: ResourceCoordinatorV1,
    session: SessionResourceHandleV1,
  ) {
    this.#coordinator = coordinator;
    this.#session = session;
    this.#scope = Object.freeze({ id: session.sessionId, kind: "session" });
  }

  public get released(): boolean {
    return this.#session.released;
  }

  public reserveAction(
    effectId: string,
    historyBytes: number,
    preparedBytes: number,
  ): boolean {
    if (this.released || this.#actions.has(effectId)) return false;
    const retention = this.#coordinator.admitBatch({
      operations: [
        this.#recordRequest(
          RESOURCE_CATEGORIES_V1.hostHistoryRecord,
          effectId,
          historyBytes,
        ),
        this.#recordRequest(
          RESOURCE_CATEGORIES_V1.recoveryRecord,
          `${effectId}:prepared`,
          preparedBytes,
        ),
      ],
    });
    if (retention.kind !== "admitted") return false;
    const prepare = this.#admitAsync(
      RESOURCE_CATEGORIES_V1.indexedDbQueueTurn,
      `${effectId}:prepare`,
    );
    const delivery = this.#admitAsyncPair(effectId);
    if (prepare === null || delivery === null) {
      prepare?.release();
      delivery?.release();
      retention.handle.release();
      return false;
    }
    this.#actions.set(effectId, {
      delivery,
      prepare,
      retention: retention.handle,
    });
    return true;
  }

  public activateRetention(effectId: string): boolean {
    const action = this.#actions.get(effectId);
    return action?.retention.activate() ?? false;
  }

  public async runPreparation(
    effectId: string,
    operation: () => Promise<boolean>,
  ): Promise<boolean> {
    const action = this.#actions.get(effectId);
    const prepare = action?.prepare;
    if (!prepare?.activate()) return false;
    try {
      const result = await operation();
      return prepare.publishCompletion(`${effectId}:prepare-completion`)
        ? result
        : false;
    } catch {
      return false;
    } finally {
      prepare.release();
    }
  }

  public async runDelivery(
    effectId: string,
    operation: () => Promise<void>,
  ): Promise<boolean> {
    const turn =
      this.#takeReservedDelivery(effectId) ?? this.#admitAsyncPair(effectId);
    if (turn !== null) return this.#runAsyncTurn(turn, operation);
    return this.#runEmergencyTurn(effectId, operation);
  }

  public releaseAction(effectId: string): boolean {
    const action = this.#actions.get(effectId);
    if (action === undefined) return false;
    this.#actions.delete(effectId);
    action.delivery?.release();
    action.prepare.release();
    action.retention.release();
    return true;
  }

  public release(): boolean {
    if (this.released) return false;
    for (const effectId of [...this.#actions.keys()]) {
      this.releaseAction(effectId);
    }
    for (const turn of this.#turns) turn.release();
    this.#turns.clear();
    return this.#session.release();
  }

  #recordRequest(
    category:
      | typeof RESOURCE_CATEGORIES_V1.hostHistoryRecord
      | typeof RESOURCE_CATEGORIES_V1.recoveryRecord,
    ownerId: string,
    bytes: number,
  ): Parameters<ResourceCoordinatorV1["admit"]>[0] {
    return {
      bytes,
      category,
      count: 1,
      ownerId,
      residency: "steady",
      scope: this.#scope,
    };
  }

  #admitAsync(
    category:
      | typeof RESOURCE_CATEGORIES_V1.indexedDbQueueTurn
      | typeof RESOURCE_CATEGORIES_V1.sessionTurn,
    ownerId: string,
  ): AsyncResourceHandleV1 | null {
    const admitted = this.#coordinator.admitAsync({
      completionBytes: ASYNC_COMPLETION_BYTES,
      operation: {
        bytes: ASYNC_OPERATION_BYTES,
        category,
        count: 1,
        ownerId,
        residency: "transient",
        scope: this.#scope,
      },
    });
    return admitted.kind === "admitted" ? admitted.handle : null;
  }

  #admitAsyncPair(effectId: string): BatchResourceHandleV1 | null {
    const admitted = this.#coordinator.admitBatch({
      completionBytes: ASYNC_COMPLETION_BYTES,
      operations: [
        this.#asyncOperation(
          RESOURCE_CATEGORIES_V1.sessionTurn,
          `${effectId}:delivery`,
        ),
        this.#asyncOperation(
          RESOURCE_CATEGORIES_V1.indexedDbQueueTurn,
          `${effectId}:recovery`,
        ),
      ],
    });
    return admitted.kind === "admitted" ? admitted.handle : null;
  }

  #takeReservedDelivery(effectId: string): BatchResourceHandleV1 | null {
    const action = this.#actions.get(effectId);
    if (action?.delivery === null || action?.delivery === undefined)
      return null;
    const turn = action.delivery;
    action.delivery = null;
    return turn;
  }

  async #runAsyncTurn(
    turn: BatchResourceHandleV1,
    operation: () => Promise<void>,
  ): Promise<boolean> {
    this.#turns.add(turn);
    if (!turn.activate()) {
      this.#turns.delete(turn);
      turn.release();
      return false;
    }
    try {
      await operation();
      return turn.publishCompletion();
    } catch {
      return false;
    } finally {
      this.#turns.delete(turn);
      turn.release();
    }
  }

  #asyncOperation(
    category:
      | typeof RESOURCE_CATEGORIES_V1.indexedDbQueueTurn
      | typeof RESOURCE_CATEGORIES_V1.sessionTurn,
    ownerId: string,
  ): Parameters<ResourceCoordinatorV1["admit"]>[0] {
    return {
      bytes: ASYNC_OPERATION_BYTES,
      category,
      count: 1,
      ownerId,
      residency: "transient",
      scope: this.#scope,
    };
  }

  async #runEmergencyTurn(
    effectId: string,
    operation: () => Promise<void>,
  ): Promise<boolean> {
    const admitted = this.#session.admitEmergency(
      "host-history",
      EMERGENCY_DELIVERY_BYTES,
      `${effectId}:emergency`,
    );
    if (admitted.kind !== "admitted") return false;
    return runEmergency(admitted.handle, operation);
  }
}

export class BoundedHistoryDeliveryQueueV1 {
  readonly #maximum: number;
  readonly #pending: (() => Promise<void>)[] = [];
  #drain: Promise<void> | null = null;
  #closed = false;

  public constructor(maximum = MAX_PENDING_HISTORY_DELIVERIES_V1) {
    this.#maximum = maximum;
  }

  public enqueue(operation: () => Promise<void>): boolean {
    if (this.#closed || this.#pending.length >= this.#maximum) return false;
    this.#pending.push(operation);
    this.#drain ??= this.#run();
    return true;
  }

  public settle(): Promise<void> {
    return this.#drain ?? Promise.resolve();
  }

  public get idle(): boolean {
    return this.#drain === null && this.#pending.length === 0;
  }

  public close(): void {
    this.#closed = true;
  }

  async #run(): Promise<void> {
    try {
      let operation = this.#pending.shift();
      while (operation !== undefined) {
        await operation();
        operation = this.#pending.shift();
      }
    } finally {
      this.#drain = null;
    }
  }
}

async function runEmergency(
  handle: EmergencyTurnHandleV1,
  operation: () => Promise<void>,
): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch {
    return false;
  } finally {
    handle.release();
  }
}

export function estimateHistoryPayloadBytesV1(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength + KIB;
}
