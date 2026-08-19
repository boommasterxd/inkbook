import { describe, expect, it, vi } from "vitest";

import { PhaseZeroViewOwnership } from "../../../../src/adapters/obsidian/views/phase-zero-view-ownership";
import {
  RESOURCE_BUDGET_V1,
  RESOURCE_CATEGORIES_V1,
  ResourceCoordinatorV1,
  type ResourceBudgetProfileV1,
  type ResourceCategoryV1,
} from "../../../../src/application/resource-coordinator";

const READING_REPLACEMENT_LIMIT = 2;
const SECOND_POINTER = 2;
const THIRD_POINTER = 3;

function coordinator(
  overrides: Readonly<
    Partial<Record<ResourceCategoryV1, { readonly perScopeCount: number }>>
  > = {},
): ResourceCoordinatorV1 {
  const base = RESOURCE_BUDGET_V1.desktopOrAndroidTablet;
  const profile: ResourceBudgetProfileV1 = {
    ...base,
    categoryLimits: { ...base.categoryLimits, ...overrides },
  };
  return new ResourceCoordinatorV1(profile);
}

function ownership(resources: ResourceCoordinatorV1): PhaseZeroViewOwnership {
  const owner = PhaseZeroViewOwnership.reserve(resources, "view-1");
  if (owner === undefined) throw new Error("Expected view ownership");
  return owner;
}

describe("PhaseZeroViewOwnership dynamic resources", () => {
  it("tracks successful, duplicate, failed, and missing pointer captures", () => {
    const resources = coordinator();
    const owner = ownership(resources);
    const capture = vi.fn();
    const release = vi.fn();

    expect(owner.capturePointer(1, capture, release)).toBe(true);
    expect(owner.capturePointer(1, capture, release)).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(owner.releasePointer(SECOND_POINTER, release)).toBe(false);
    expect(owner.releasePointer(1, release)).toBe(true);
    expect(owner.releasePointer(1, release)).toBe(false);
    expect(
      owner.capturePointer(
        SECOND_POINTER,
        () => {
          throw new Error("host rejected capture");
        },
        release,
      ),
    ).toBe(false);

    owner.dispose();
    expect(resources.snapshot().balanced).toBe(true);
    expect(owner.capturePointer(THIRD_POINTER, capture, release)).toBe(false);
  });

  it("owns timer leases and releases remaining captures on disposal", () => {
    const resources = coordinator();
    const owner = ownership(resources);
    const timer = owner.reserveTimer();
    expect(timer).toBeDefined();
    timer?.dispose();
    timer?.dispose();
    owner.capturePointer(
      1,
      () => undefined,
      () => undefined,
    );
    owner.capturePointer(
      SECOND_POINTER,
      () => undefined,
      () => undefined,
    );
    const release = vi.fn();
    owner.releaseAllPointers(release);
    expect(release).toHaveBeenCalledTimes(READING_REPLACEMENT_LIMIT);

    owner.dispose();
    owner.dispose();
    expect(resources.snapshot().balanced).toBe(true);
    expect(owner.reserveTimer()).toBeUndefined();
  });

  it("fails closed after coordinator disposal", () => {
    const resources = coordinator();
    const owner = ownership(resources);
    resources.dispose();

    expect(owner.reserveTimer()).toBeUndefined();
    expect(owner.prepareReadingGeneration("section", 1)).toBeUndefined();
    owner.dispose();
    expect(resources.snapshot().balanced).toBe(true);
  });

  it("releases a host capture when activation loses a disposal race", () => {
    const resources = coordinator();
    const owner = ownership(resources);
    const release = vi.fn();

    expect(owner.capturePointer(1, () => resources.dispose(), release)).toBe(
      false,
    );
    expect(release).toHaveBeenCalledOnce();
    owner.dispose();
    expect(resources.snapshot().balanced).toBe(true);
  });
});

describe("PhaseZeroViewOwnership Reading generations", () => {
  it("accounts current and retiring generations separately", () => {
    const resources = coordinator({
      [RESOURCE_CATEGORIES_V1.readingViewChild]: {
        perScopeCount: READING_REPLACEMENT_LIMIT,
      },
      [RESOURCE_CATEGORIES_V1.readingViewObserver]: {
        perScopeCount: READING_REPLACEMENT_LIMIT,
      },
      [RESOURCE_CATEGORIES_V1.readingViewReport]: {
        perScopeCount: READING_REPLACEMENT_LIMIT,
      },
    });
    const owner = ownership(resources);
    const first = owner.prepareReadingGeneration("section", 1);
    expect(first?.commit()).toBe(true);
    const second = owner.prepareReadingGeneration(
      "section",
      READING_REPLACEMENT_LIMIT,
    );
    expect(second?.commit()).toBe(true);
    expect(
      resources.snapshot().categories[
        RESOURCE_CATEGORIES_V1.readingViewObserver
      ]?.current.count,
    ).toBe(READING_REPLACEMENT_LIMIT);

    first?.release();
    first?.release();
    second?.release();
    owner.dispose();
    expect(resources.snapshot().balanced).toBe(true);
  });

  it("releases cancelled, uncommitted, and over-limit generations", () => {
    const resources = coordinator({
      [RESOURCE_CATEGORIES_V1.readingViewChild]: { perScopeCount: 1 },
      [RESOURCE_CATEGORIES_V1.readingViewObserver]: { perScopeCount: 1 },
      [RESOURCE_CATEGORIES_V1.readingViewReport]: { perScopeCount: 1 },
    });
    const owner = ownership(resources);
    const cancelled = owner.prepareReadingGeneration("cancelled", 1);
    cancelled?.cancel();
    cancelled?.cancel();
    expect(cancelled?.commit()).toBe(false);

    const current = owner.prepareReadingGeneration("section", 1);
    expect(current?.commit()).toBe(true);
    expect(
      owner.prepareReadingGeneration("section", READING_REPLACEMENT_LIMIT),
    ).toBeUndefined();
    current?.release();

    const releasedBeforeCommit = owner.prepareReadingGeneration("late", 1);
    releasedBeforeCommit?.release();
    expect(releasedBeforeCommit?.commit()).toBe(false);
    owner.dispose();
    expect(resources.snapshot().balanced).toBe(true);
  });

  it("rejects stale and disposed generation commits without leaking", () => {
    const resources = coordinator({
      [RESOURCE_CATEGORIES_V1.readingViewChild]: {
        perScopeCount: READING_REPLACEMENT_LIMIT,
      },
      [RESOURCE_CATEGORIES_V1.readingViewObserver]: {
        perScopeCount: READING_REPLACEMENT_LIMIT,
      },
      [RESOURCE_CATEGORIES_V1.readingViewReport]: {
        perScopeCount: READING_REPLACEMENT_LIMIT,
      },
    });
    const owner = ownership(resources);
    const first = owner.prepareReadingGeneration("section", 1);
    const stale = owner.prepareReadingGeneration(
      "section",
      READING_REPLACEMENT_LIMIT,
    );
    expect(first?.commit()).toBe(true);
    expect(stale?.commit()).toBe(false);

    const afterDispose = owner.prepareReadingGeneration("other", 1);
    owner.dispose();
    expect(afterDispose?.commit()).toBe(false);
    expect(resources.snapshot().balanced).toBe(true);
  });
});
