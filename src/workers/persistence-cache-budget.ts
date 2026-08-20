export const PERSISTENCE_CACHE_TOTAL_BYTES_V1 = 16_777_216;
export const PERSISTENCE_WORKER_CACHE_BYTES_V1 = 8_388_608;
export const PERSISTENCE_FALLBACK_CACHE_BYTES_V1 = 8_388_608;
export const PERSISTENCE_CACHE_TOTAL_COUNT_V1 = 100_000;
export const PERSISTENCE_WORKER_CACHE_COUNT_V1 = 50_000;
export const PERSISTENCE_FALLBACK_CACHE_COUNT_V1 = 50_000;

export function assertPersistenceCacheBudgetV1(
  workerBytes: number,
  fallbackBytes: number,
  workerCount: number,
  fallbackCount: number,
): void {
  if (
    !Number.isSafeInteger(workerBytes) ||
    workerBytes <= 0 ||
    !Number.isSafeInteger(fallbackBytes) ||
    fallbackBytes <= 0 ||
    workerBytes > PERSISTENCE_CACHE_TOTAL_BYTES_V1 - fallbackBytes ||
    !Number.isSafeInteger(workerCount) ||
    workerCount <= 0 ||
    !Number.isSafeInteger(fallbackCount) ||
    fallbackCount <= 0 ||
    workerCount > PERSISTENCE_CACHE_TOTAL_COUNT_V1 - fallbackCount
  ) {
    throw new RangeError("Persistence cache budgets exceed their local limit.");
  }
}
