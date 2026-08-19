import type {
  AsyncResourceAdmissionRequestV1,
  ResourceAdmissionRequestV1,
  ResourceCategorySnapshotV1,
  ResourceChargeV1,
} from "./types";

export interface MutableCharge {
  bytes: number;
  count: number;
}

export interface MutableCategoryStats {
  readonly current: MutableCharge;
  readonly highWater: MutableCharge;
  readonly rejected: MutableCharge;
  readonly released: MutableCharge;
  readonly reserved: MutableCharge;
  readonly suspended: MutableCharge;
}

export interface LedgerEntry {
  readonly id: number;
  readonly request: ResourceAdmissionRequestV1;
  ownerId: string;
  state: "reserved" | "current" | "released";
}

export const createZeroCharge = (): MutableCharge => ({ bytes: 0, count: 0 });
export const RELEASE_DIRECTION = ~0;

export function createCompletionRequest(
  request: AsyncResourceAdmissionRequestV1,
): ResourceAdmissionRequestV1 {
  return {
    bytes: request.completionBytes,
    category: "async-continuation",
    count: 1,
    ownerId: request.operation.ownerId,
    residency: "transient",
    ...(request.operation.disposition === undefined
      ? {}
      : { disposition: request.operation.disposition }),
    ...(request.operation.scope === undefined
      ? {}
      : { scope: request.operation.scope }),
  };
}

export function isValidRequest(request: ResourceAdmissionRequestV1): boolean {
  return (
    request.category.trim().length > 0 &&
    request.ownerId.trim().length > 0 &&
    isValidCharge(request) &&
    (request.scope === undefined || request.scope.id.trim().length > 0)
  );
}

export function isValidCharge(charge: ResourceChargeV1): boolean {
  return (
    Number.isSafeInteger(charge.count) &&
    charge.count > 0 &&
    Number.isSafeInteger(charge.bytes) &&
    charge.bytes >= 0
  );
}

export function freezeRequest(
  request: ResourceAdmissionRequestV1,
): ResourceAdmissionRequestV1 {
  return Object.freeze({
    ...request,
    ...(request.scope === undefined
      ? {}
      : { scope: Object.freeze(request.scope) }),
  });
}

export function scopeKey(request: ResourceAdmissionRequestV1): string {
  const scope = request.scope;
  if (scope === undefined) return "";
  return `${request.category}\u0000${scope.kind}\u0000${scope.id}`;
}

export function groupScopeKey(
  group: string,
  request: ResourceAdmissionRequestV1,
): string {
  const scope = request.scope;
  if (scope === undefined) return "";
  return `${group}\u0000${scope.kind}\u0000${scope.id}`;
}

export function add(
  map: Map<string, MutableCharge>,
  key: string,
  charge: ResourceChargeV1,
): void {
  addCharge(getOrCreate(map, key), charge);
}

export function addSigned(
  map: Map<string, MutableCharge>,
  key: string,
  charge: ResourceChargeV1,
  direction: number,
): void {
  const target = getOrCreate(map, key);
  target.bytes += direction * charge.bytes;
  target.count += direction * charge.count;
  if (target.bytes === 0 && target.count === 0) map.delete(key);
}

function getOrCreate(
  map: Map<string, MutableCharge>,
  key: string,
): MutableCharge {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = createZeroCharge();
  map.set(key, created);
  return created;
}

export function addCharge(
  target: MutableCharge,
  charge: ResourceChargeV1,
): void {
  target.bytes += charge.bytes;
  target.count += charge.count;
}

export function subtractCharge(
  target: MutableCharge,
  charge: ResourceChargeV1,
): void {
  target.bytes -= charge.bytes;
  target.count -= charge.count;
}

export function sum(
  left: ResourceChargeV1 | undefined,
  right: ResourceChargeV1 | undefined,
): MutableCharge {
  return {
    bytes: (left?.bytes ?? 0) + (right?.bytes ?? 0),
    count: (left?.count ?? 0) + (right?.count ?? 0),
  };
}

export function updateHighWater(
  stats: MutableCategoryStats,
  live: ResourceChargeV1 | undefined,
): void {
  if (live !== undefined) updateMaximum(stats.highWater, live);
}

export function updateMaximum(
  target: MutableCharge,
  value: ResourceChargeV1,
): void {
  target.bytes = Math.max(target.bytes, value.bytes);
  target.count = Math.max(target.count, value.count);
}

export function freezeCharge(charge: ResourceChargeV1): ResourceChargeV1 {
  return Object.freeze({ bytes: charge.bytes, count: charge.count });
}

export function freezeCategory(
  stats: MutableCategoryStats,
): ResourceCategorySnapshotV1 {
  return Object.freeze({
    current: freezeCharge(stats.current),
    highWater: freezeCharge(stats.highWater),
    rejected: freezeCharge(stats.rejected),
    released: freezeCharge(stats.released),
    reserved: freezeCharge(stats.reserved),
    suspended: freezeCharge(stats.suspended),
  });
}
