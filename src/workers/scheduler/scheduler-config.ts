import type { ByteWorkerSchedulerOptions } from "./scheduler-types";
import { assertPositiveCapacityLimit } from "./work-profiles";

const DEFAULT_MAX_OUTSTANDING_REQUESTS = 8;
const DEFAULT_MAX_OUTSTANDING_BYTES = 4_194_304;
const MAX_CONFIGURED_OUTSTANDING_REQUESTS = 64;
const MAX_CONFIGURED_OUTSTANDING_BYTES = 16_777_216;
const DEFAULT_MAX_RESERVED_BYTES = 167_772_160;
const MAX_CONFIGURED_RESERVED_BYTES = 201_326_592;

export interface SchedulerLimits {
  readonly maxOutstandingRequests: number;
  readonly maxOutstandingBytes: number;
  readonly maxReservedBytes: number;
}

export function readSchedulerLimits(
  options: ByteWorkerSchedulerOptions,
): SchedulerLimits {
  const limits = {
    maxOutstandingRequests:
      options.maxOutstandingRequests ?? DEFAULT_MAX_OUTSTANDING_REQUESTS,
    maxOutstandingBytes:
      options.maxOutstandingBytes ?? DEFAULT_MAX_OUTSTANDING_BYTES,
    maxReservedBytes: options.maxReservedBytes ?? DEFAULT_MAX_RESERVED_BYTES,
  };
  assertPositiveCapacityLimit(
    "maxOutstandingRequests",
    limits.maxOutstandingRequests,
    MAX_CONFIGURED_OUTSTANDING_REQUESTS,
  );
  assertPositiveCapacityLimit(
    "maxOutstandingBytes",
    limits.maxOutstandingBytes,
    MAX_CONFIGURED_OUTSTANDING_BYTES,
  );
  assertPositiveCapacityLimit(
    "maxReservedBytes",
    limits.maxReservedBytes,
    MAX_CONFIGURED_RESERVED_BYTES,
  );
  return limits;
}
