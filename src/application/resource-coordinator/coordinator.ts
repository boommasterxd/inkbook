import {
  RESOURCE_CATEGORIES_V1,
  type AsyncResourceAdmissionRequestV1,
  type AsyncResourceHandleV1,
  type BatchResourceAdmissionRequestV1,
  type BatchResourceHandleV1,
  type EmergencyTurnHandleV1,
  type ResourceAdmissionFailureReasonV1,
  type ResourceAdmissionHandleV1,
  type ResourceAdmissionRequestV1,
  type ResourceAdmissionResultV1,
  type ResourceBudgetProfileV1,
  type ResourceCategoryV1,
  type ResourceCategorySnapshotV1,
  type ResourceChargeV1,
  type ResourceCoordinatorSnapshotV1,
  type SessionResourceHandleV1,
} from "./types";
import {
  createAdmissionHandle,
  createAsyncHandle,
  createBatchHandle,
  createSessionHandle,
} from "./handles";
import {
  add,
  addCharge,
  addSigned,
  createZeroCharge,
  createCompletionRequest,
  freezeCategory,
  freezeCharge,
  freezeRequest,
  groupScopeKey,
  isValidCharge,
  isValidRequest,
  RELEASE_DIRECTION,
  scopeKey,
  subtractCharge,
  sum,
  updateHighWater,
  updateMaximum,
  type LedgerEntry,
  type MutableCategoryStats,
  type MutableCharge,
} from "./ledger";

interface BatchFailure {
  readonly reason: ResourceAdmissionFailureReasonV1;
  readonly request: ResourceAdmissionRequestV1;
}

export class ResourceCoordinatorV1 {
  readonly #profile: ResourceBudgetProfileV1;
  readonly #entries = new Map<number, LedgerEntry>();
  readonly #categoryLive = new Map<string, MutableCharge>();
  readonly #groupLive = new Map<string, MutableCharge>();
  readonly #groupScopeLive = new Map<string, MutableCharge>();
  readonly #scopeLive = new Map<string, MutableCharge>();
  readonly #stats = new Map<ResourceCategoryV1, MutableCategoryStats>();
  readonly #current = createZeroCharge();
  readonly #reserved = createZeroCharge();
  readonly #highWater = createZeroCharge();
  readonly #rejected = createZeroCharge();
  readonly #released = createZeroCharge();
  readonly #suspended = createZeroCharge();
  #steadyBytes = 0;
  #transientBytes = 0;
  #nextId = 1;
  #disposed = false;

  public constructor(profile: ResourceBudgetProfileV1) {
    this.#profile = profile;
  }

  public admit(request: ResourceAdmissionRequestV1): ResourceAdmissionResultV1 {
    const result = this.#reserveBatch([request]);
    if (result.kind !== "admitted") return result;
    const handle = result.handles[0];
    if (handle === undefined)
      throw new Error("Missing admitted resource handle");
    return Object.freeze({ kind: "admitted", handle });
  }

  public admitAsync(
    request: AsyncResourceAdmissionRequestV1,
  ): ResourceAdmissionResultV1<AsyncResourceHandleV1> {
    const completion = createCompletionRequest(request);
    const result = this.#reserveBatch([request.operation, completion]);
    if (result.kind !== "admitted") return result;
    const operation = result.handles[0];
    const completionHandle = result.handles[1];
    if (operation === undefined || completionHandle === undefined) {
      throw new Error("Missing admitted asynchronous resource handles");
    }
    return Object.freeze({
      kind: "admitted",
      handle: createAsyncHandle(operation, completionHandle),
    });
  }

  public admitBatch(
    request: BatchResourceAdmissionRequestV1,
  ): ResourceAdmissionResultV1<BatchResourceHandleV1> {
    const firstOperation = request.operations[0];
    if (firstOperation === undefined) {
      return Object.freeze({ kind: "rejected", reason: "invalid-request" });
    }
    const completion =
      request.completionBytes === undefined
        ? undefined
        : createCompletionRequest({
            completionBytes: request.completionBytes,
            operation: firstOperation,
          });
    const requests =
      completion === undefined
        ? request.operations
        : [...request.operations, completion];
    const result = this.#reserveBatch(requests);
    if (result.kind !== "admitted") return result;
    const operationHandles = result.handles.slice(0, request.operations.length);
    const completionHandle = result.handles[request.operations.length];
    if (completion !== undefined && completionHandle === undefined) {
      throw new Error("Missing admitted batch completion handle");
    }
    return Object.freeze({
      kind: "admitted",
      handle: createBatchHandle(operationHandles, completionHandle),
    });
  }

  public admitSession(
    sessionId: string,
    residentBytes: number,
  ): ResourceAdmissionResultV1<SessionResourceHandleV1> {
    const scope = Object.freeze({ id: sessionId, kind: "session" as const });
    const emergencyBytes = this.#profile.emergencyPayloadBytes;
    const requests: readonly ResourceAdmissionRequestV1[] = [
      {
        bytes: residentBytes,
        category: RESOURCE_CATEGORIES_V1.noteSession,
        count: 1,
        ownerId: sessionId,
        residency: "steady",
        scope,
      },
      {
        bytes: emergencyBytes,
        category: RESOURCE_CATEGORIES_V1.lifecycleEmergency,
        count: 1,
        ownerId: sessionId,
        residency: "transient",
        scope,
      },
      {
        bytes: emergencyBytes,
        category: RESOURCE_CATEGORIES_V1.hostHistoryEmergency,
        count: 1,
        ownerId: sessionId,
        residency: "transient",
        scope,
      },
    ];
    const result = this.#reserveBatch(requests);
    if (result.kind !== "admitted") return result;
    const [session, lifecycle, history] = result.handles;
    if (
      session === undefined ||
      lifecycle === undefined ||
      history === undefined
    ) {
      throw new Error("Missing admitted session resource handles");
    }
    session.activate();
    return Object.freeze({
      kind: "admitted",
      handle: createSessionHandle(
        sessionId,
        emergencyBytes,
        [session, lifecycle, history],
        (category, charge, reason) =>
          this.#recordRejected(category, charge, reason),
      ),
    });
  }

  public snapshot(): ResourceCoordinatorSnapshotV1 {
    const categories: Partial<
      Record<ResourceCategoryV1, ResourceCategorySnapshotV1>
    > = {};
    for (const [category, stats] of this.#stats) {
      categories[category] = freezeCategory(stats);
    }
    return Object.freeze({
      balanced:
        this.#current.count === 0 &&
        this.#current.bytes === 0 &&
        this.#reserved.count === 0 &&
        this.#reserved.bytes === 0,
      categories: Object.freeze(categories),
      current: freezeCharge(this.#current),
      disposed: this.#disposed,
      highWater: freezeCharge(this.#highWater),
      rejected: freezeCharge(this.#rejected),
      released: freezeCharge(this.#released),
      reserved: freezeCharge(this.#reserved),
      suspended: freezeCharge(this.#suspended),
    });
  }

  public dispose(): boolean {
    if (this.#disposed) return false;
    this.#disposed = true;
    for (const entry of [...this.#entries.values()]) this.#release(entry);
    return true;
  }

  #reserveBatch(requests: readonly ResourceAdmissionRequestV1[]):
    | {
        readonly kind: "admitted";
        readonly handles: ResourceAdmissionHandleV1[];
      }
    | Exclude<ResourceAdmissionResultV1, { readonly kind: "admitted" }> {
    const chargedRequests = requests.map((request) =>
      this.#chargedRequest(request),
    );
    const failure = this.#preflight(chargedRequests);
    if (failure !== null) return this.#deny(failure);
    const handles = chargedRequests.map((request) => this.#reserve(request));
    return { kind: "admitted", handles };
  }

  #chargedRequest(
    request: ResourceAdmissionRequestV1,
  ): ResourceAdmissionRequestV1 {
    const baseBytes =
      this.#profile.categoryLimits[request.category]?.baseBytes ?? 0;
    return { ...request, bytes: request.bytes + baseBytes * request.count };
  }

  #preflight(
    requests: readonly ResourceAdmissionRequestV1[],
  ): BatchFailure | null {
    const categoryDeltas = new Map<string, MutableCharge>();
    const groupDeltas = new Map<string, MutableCharge>();
    const groupScopeDeltas = new Map<string, MutableCharge>();
    const scopeDeltas = new Map<string, MutableCharge>();
    let steadyDelta = 0;
    let transientDelta = 0;
    for (const request of requests) {
      if (!isValidRequest(request))
        return { reason: "invalid-request", request };
      if (this.#disposed) return { reason: "disposed", request };
      add(categoryDeltas, request.category, request);
      if (request.scope !== undefined)
        add(scopeDeltas, scopeKey(request), request);
      const group = this.#profile.categoryLimits[request.category]?.group;
      if (group !== undefined) {
        add(groupDeltas, group, request);
        if (request.scope !== undefined) {
          add(groupScopeDeltas, groupScopeKey(group, request), request);
        }
      }
      if (request.residency === "steady") steadyDelta += request.bytes;
      transientDelta += request.bytes;
      const failure = this.#limitFailure(
        request,
        categoryDeltas,
        scopeDeltas,
        groupDeltas,
        groupScopeDeltas,
      );
      if (failure !== null) return { reason: failure, request };
      if (this.#steadyBytes + steadyDelta > this.#profile.steadyResidentBytes) {
        return { reason: "steady-byte-limit", request };
      }
      if (
        this.#transientBytes + transientDelta >
        this.#profile.transientResidentBytes
      ) {
        return { reason: "transient-byte-limit", request };
      }
    }
    return null;
  }

  #limitFailure(
    request: ResourceAdmissionRequestV1,
    categoryDeltas: ReadonlyMap<string, MutableCharge>,
    scopeDeltas: ReadonlyMap<string, MutableCharge>,
    groupDeltas: ReadonlyMap<string, MutableCharge>,
    groupScopeDeltas: ReadonlyMap<string, MutableCharge>,
  ): ResourceAdmissionFailureReasonV1 | null {
    const limit = this.#profile.categoryLimits[request.category];
    if (limit === undefined) return null;
    const category = sum(
      this.#categoryLive.get(request.category),
      categoryDeltas.get(request.category),
    );
    if (limit.count !== undefined && category.count > limit.count) {
      return "category-count-limit";
    }
    if (limit.bytes !== undefined && category.bytes > limit.bytes) {
      return "category-byte-limit";
    }
    if (request.scope !== undefined) {
      const scope = sum(
        this.#scopeLive.get(scopeKey(request)),
        scopeDeltas.get(scopeKey(request)),
      );
      if (
        limit.perScopeCount !== undefined &&
        scope.count > limit.perScopeCount
      ) {
        return "scope-count-limit";
      }
      if (
        limit.perScopeBytes !== undefined &&
        scope.bytes > limit.perScopeBytes
      ) {
        return "scope-byte-limit";
      }
    }
    return this.#groupLimitFailure(
      request,
      limit.group,
      groupDeltas,
      groupScopeDeltas,
    );
  }

  #groupLimitFailure(
    request: ResourceAdmissionRequestV1,
    group: string | undefined,
    groupDeltas: ReadonlyMap<string, MutableCharge>,
    groupScopeDeltas: ReadonlyMap<string, MutableCharge>,
  ): ResourceAdmissionFailureReasonV1 | null {
    if (group === undefined) return null;
    const limit = this.#profile.groupLimits[group];
    if (limit === undefined) return null;
    const live = sum(this.#groupLive.get(group), groupDeltas.get(group));
    if (limit.count !== undefined && live.count > limit.count) {
      return "group-count-limit";
    }
    if (limit.bytes !== undefined && live.bytes > limit.bytes) {
      return "group-byte-limit";
    }
    if (request.scope === undefined) return null;
    const key = groupScopeKey(group, request);
    const scoped = sum(
      this.#groupScopeLive.get(key),
      groupScopeDeltas.get(key),
    );
    if (
      limit.perScopeCount !== undefined &&
      scoped.count > limit.perScopeCount
    ) {
      return "group-count-limit";
    }
    if (
      limit.perScopeBytes !== undefined &&
      scoped.bytes > limit.perScopeBytes
    ) {
      return "group-byte-limit";
    }
    return null;
  }

  #deny(
    failure: BatchFailure,
  ): Exclude<ResourceAdmissionResultV1, { readonly kind: "admitted" }> {
    const disposition = failure.request.disposition ?? "reject";
    if (isValidCharge(failure.request)) {
      const stats = this.#statsFor(failure.request.category);
      addCharge(
        disposition === "suspend" ? stats.suspended : stats.rejected,
        failure.request,
      );
      addCharge(
        disposition === "suspend" ? this.#suspended : this.#rejected,
        failure.request,
      );
    }
    return Object.freeze({
      kind: disposition === "suspend" ? "suspended" : "rejected",
      reason: failure.reason,
    });
  }

  #recordRejected(
    category: ResourceCategoryV1,
    charge: ResourceChargeV1,
    reason: ResourceAdmissionFailureReasonV1,
  ): ResourceAdmissionResultV1<EmergencyTurnHandleV1> {
    if (isValidCharge(charge)) {
      addCharge(this.#statsFor(category).rejected, charge);
      addCharge(this.#rejected, charge);
    }
    return Object.freeze({ kind: "rejected", reason });
  }

  #reserve(request: ResourceAdmissionRequestV1): ResourceAdmissionHandleV1 {
    const entry: LedgerEntry = {
      id: this.#nextId,
      ownerId: request.ownerId,
      request: freezeRequest(request),
      state: "reserved",
    };
    this.#nextId += 1;
    this.#entries.set(entry.id, entry);
    this.#chargeLive(entry.request, 1);
    addCharge(this.#reserved, entry.request);
    const stats = this.#statsFor(entry.request.category);
    addCharge(stats.reserved, entry.request);
    updateHighWater(stats, this.#categoryLive.get(entry.request.category));
    updateMaximum(this.#highWater, sum(this.#current, this.#reserved));
    return createAdmissionHandle(this, entry);
  }

  #chargeLive(request: ResourceAdmissionRequestV1, direction: number): void {
    addSigned(this.#categoryLive, request.category, request, direction);
    if (request.scope !== undefined) {
      addSigned(this.#scopeLive, scopeKey(request), request, direction);
    }
    const group = this.#profile.categoryLimits[request.category]?.group;
    if (group !== undefined) {
      addSigned(this.#groupLive, group, request, direction);
      if (request.scope !== undefined) {
        addSigned(
          this.#groupScopeLive,
          groupScopeKey(group, request),
          request,
          direction,
        );
      }
    }
    if (request.residency === "steady") {
      this.#steadyBytes += direction * request.bytes;
    }
    this.#transientBytes += direction * request.bytes;
  }

  #activate(entry: LedgerEntry): boolean {
    if (entry.state !== "reserved" || !this.#entries.has(entry.id))
      return false;
    entry.state = "current";
    subtractCharge(this.#reserved, entry.request);
    addCharge(this.#current, entry.request);
    const stats = this.#statsFor(entry.request.category);
    subtractCharge(stats.reserved, entry.request);
    addCharge(stats.current, entry.request);
    return true;
  }

  #release(entry: LedgerEntry): boolean {
    if (entry.state === "released" || !this.#entries.has(entry.id))
      return false;
    const stats = this.#statsFor(entry.request.category);
    subtractCharge(
      entry.state === "reserved" ? stats.reserved : stats.current,
      entry.request,
    );
    subtractCharge(
      entry.state === "reserved" ? this.#reserved : this.#current,
      entry.request,
    );
    addCharge(stats.released, entry.request);
    addCharge(this.#released, entry.request);
    this.#chargeLive(entry.request, RELEASE_DIRECTION);
    entry.state = "released";
    this.#entries.delete(entry.id);
    return true;
  }

  #transfer(entry: LedgerEntry, ownerId: string): boolean {
    if (
      entry.state === "released" ||
      !this.#entries.has(entry.id) ||
      ownerId.trim().length === 0
    ) {
      return false;
    }
    entry.ownerId = ownerId;
    return true;
  }

  #statsFor(category: ResourceCategoryV1): MutableCategoryStats {
    const existing = this.#stats.get(category);
    if (existing !== undefined) return existing;
    const created = {
      current: createZeroCharge(),
      highWater: createZeroCharge(),
      rejected: createZeroCharge(),
      released: createZeroCharge(),
      reserved: createZeroCharge(),
      suspended: createZeroCharge(),
    };
    this.#stats.set(category, created);
    return created;
  }

  public activateHandle(entry: LedgerEntry): boolean {
    return this.#activate(entry);
  }

  public releaseHandle(entry: LedgerEntry): boolean {
    return this.#release(entry);
  }

  public transferHandle(entry: LedgerEntry, ownerId: string): boolean {
    return this.#transfer(entry, ownerId);
  }
}
