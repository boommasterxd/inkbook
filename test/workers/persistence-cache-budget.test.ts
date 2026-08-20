import { expect, it } from "vitest";

import {
  assertPersistenceCacheBudgetV1,
  PERSISTENCE_CACHE_TOTAL_BYTES_V1,
  PERSISTENCE_CACHE_TOTAL_COUNT_V1,
  PERSISTENCE_FALLBACK_CACHE_BYTES_V1,
  PERSISTENCE_FALLBACK_CACHE_COUNT_V1,
  PERSISTENCE_WORKER_CACHE_BYTES_V1,
  PERSISTENCE_WORKER_CACHE_COUNT_V1,
} from "../../src/workers/persistence-cache-budget";

const ONE_BYTE = 1;
const EMPTY_BUDGET = 0;

it("admits persistence cache budgets below and at the combined limit", () => {
  expect(
    PERSISTENCE_WORKER_CACHE_BYTES_V1 + PERSISTENCE_FALLBACK_CACHE_BYTES_V1,
  ).toBe(PERSISTENCE_CACHE_TOTAL_BYTES_V1);
  expect(
    PERSISTENCE_WORKER_CACHE_COUNT_V1 + PERSISTENCE_FALLBACK_CACHE_COUNT_V1,
  ).toBe(PERSISTENCE_CACHE_TOTAL_COUNT_V1);
  expect(() =>
    assertPersistenceCacheBudgetV1(
      PERSISTENCE_WORKER_CACHE_BYTES_V1,
      PERSISTENCE_FALLBACK_CACHE_BYTES_V1 - ONE_BYTE,
      PERSISTENCE_WORKER_CACHE_COUNT_V1,
      PERSISTENCE_FALLBACK_CACHE_COUNT_V1,
    ),
  ).not.toThrow();
  expect(() =>
    assertPersistenceCacheBudgetV1(
      PERSISTENCE_WORKER_CACHE_BYTES_V1,
      PERSISTENCE_FALLBACK_CACHE_BYTES_V1,
      PERSISTENCE_WORKER_CACHE_COUNT_V1,
      PERSISTENCE_FALLBACK_CACHE_COUNT_V1,
    ),
  ).not.toThrow();
});

it.each([
  PERSISTENCE_FALLBACK_CACHE_BYTES_V1 + ONE_BYTE,
  EMPTY_BUDGET,
  Number.NaN,
])("rejects an invalid fallback cache budget of %s bytes", (fallbackBytes) => {
  expect(() =>
    assertPersistenceCacheBudgetV1(
      PERSISTENCE_WORKER_CACHE_BYTES_V1,
      fallbackBytes,
      PERSISTENCE_WORKER_CACHE_COUNT_V1,
      PERSISTENCE_FALLBACK_CACHE_COUNT_V1,
    ),
  ).toThrow(RangeError);
});

it.each([
  PERSISTENCE_FALLBACK_CACHE_COUNT_V1 + ONE_BYTE,
  EMPTY_BUDGET,
  Number.NaN,
])("rejects an invalid fallback cache count of %s", (fallbackCount) => {
  expect(() =>
    assertPersistenceCacheBudgetV1(
      PERSISTENCE_WORKER_CACHE_BYTES_V1,
      PERSISTENCE_FALLBACK_CACHE_BYTES_V1,
      PERSISTENCE_WORKER_CACHE_COUNT_V1,
      fallbackCount,
    ),
  ).toThrow(RangeError);
});
