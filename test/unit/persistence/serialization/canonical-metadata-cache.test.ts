import { afterEach, describe, expect, it, vi } from "vitest";
import { CanonicalMetadataCache } from "../../../../src/persistence/serialization/canonical-metadata-cache";
import { canonicalMetadataSha256 } from "../../../../src/persistence/serialization/canonical-metadata";
import * as canonical from "../../../../src/persistence/serialization/canonical-snapshot";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
import { rectangle, snapshot } from "../worker/runtime/fixtures";

const checkpoint = async () => undefined;
afterEach(() => vi.restoreAllMocks());

describe("canonical metadata cache", () => {
  it("reuses immutable element bytes but hashes every revision and changed element exactly", async () => {
    const element = Object.freeze(rectangle());
    const value = { ...snapshot(), elements: [element] };
    const cache = new CanonicalMetadataCache(Object.isFrozen);
    const expected = canonicalMetadataSha256(value);
    const canonicalize = vi.spyOn(canonical, "canonicalElement");
    expect(await cache.digest(value, checkpoint)).toBe(expected);
    canonicalize.mockClear();
    expect(await cache.digest(value, checkpoint)).toBe(expected);
    expect(canonicalize).not.toHaveBeenCalled();
    const next = { ...value, revision: 1, elements: [Object.freeze({ ...element, x: 300 })] };
    const nextExpected = canonicalMetadataSha256(next);
    canonicalize.mockClear();
    expect(await cache.digest(next, checkpoint)).toBe(nextExpected);
    expect(canonicalize).toHaveBeenCalledOnce();
    cache.clear();
    canonicalize.mockClear();
    await cache.digest(next, checkpoint);
    expect(canonicalize).toHaveBeenCalledOnce();
  });

  it("never caches mutable snapshots and preserves the exact proof without native crypto", async () => {
    const value = snapshot();
    const cache = new CanonicalMetadataCache();
    vi.stubGlobal("crypto", undefined);
    try {
      expect(await cache.digest(value, checkpoint)).toBe(canonicalMetadataSha256(value));
      value.elements = [rectangle(400)];
      expect(await cache.digest(value, checkpoint)).toBe(canonicalMetadataSha256(value));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not trust a frozen wrapper whose nested element data remains mutable", async () => {
    const element = rectangle();
    Object.freeze(element);
    const value = { ...snapshot(), elements: [element] };
    const cache = new CanonicalMetadataCache();
    const previous = await cache.digest(value, checkpoint);
    Object.assign(element.style, { outlineOpacity: 0.25 });
    const next = await cache.digest(value, checkpoint);
    expect(next).not.toBe(previous);
    expect(next).toBe(canonicalMetadataSha256(value));
  });
});

describe("stroke metadata reuse", () => {
  it("keeps a changed stroke header exact while reusing owned samples", async () => {
    const points = createTestStroke().points;
    Object.freeze(points);
    const first = Object.freeze({ ...createTestStroke(), points });
    const value = { ...snapshot(), elements: [first] };
    const cache = new CanonicalMetadataCache(Object.isFrozen);
    expect(await cache.digest(value, checkpoint)).toBe(canonicalMetadataSha256(value));
    const moved = Object.freeze({ ...first, offset: { x: 12.5, y: -7 } });
    value.elements = [moved];
    expect(await cache.digest(value, checkpoint)).toBe(canonicalMetadataSha256(value));
    const restyled = Object.freeze({
      ...moved,
      style: { ...moved.style, opacity: 0.4 },
    });
    value.elements = [restyled];
    expect(await cache.digest(value, checkpoint)).toBe(canonicalMetadataSha256(value));
  });

  it("re-encodes unowned mutable samples even when the stroke identity is unchanged", async () => {
    const stroke = createTestStroke();
    const value = { ...snapshot(), elements: [stroke] };
    const cache = new CanonicalMetadataCache();
    const first = await cache.digest(value, checkpoint);
    stroke.points[2] = 0.75;
    const second = await cache.digest(value, checkpoint);
    expect(second).not.toBe(first);
    expect(second).toBe(canonicalMetadataSha256(value));
  });

  it.each(["reject", "malformed"])("falls back when native hashing is %s", async (mode) => {
    const value = snapshot();
    vi.stubGlobal("crypto", {
      subtle: {
        digest: async () => {
          if (mode === "reject") throw new Error("Unavailable");
          return new ArrayBuffer(1);
        },
      },
    });
    try {
      expect(await new CanonicalMetadataCache().digest(value, checkpoint)).toBe(
        canonicalMetadataSha256(value),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cancels between fragments and does not repopulate a released in-flight cache", async () => {
    const value = { ...snapshot(), elements: [Object.freeze(rectangle())] };
    const cache = new CanonicalMetadataCache(Object.isFrozen);
    const abort = new AbortController();
    await expect(
      cache.digest(
        value,
        async () => {
          abort.abort();
        },
        abort.signal,
      ),
    ).rejects.toThrow();
    let cleared = false;
    await cache.digest(value, async () => {
      if (!cleared) {
        cache.clear();
        cleared = true;
      }
    });
    const canonicalize = vi.spyOn(canonical, "canonicalElement");
    await cache.digest(value, checkpoint);
    expect(canonicalize).toHaveBeenCalledOnce();
  });
});

it("cancels a cached digest at its bounded traversal checkpoint", async () => {
  const elements = Array.from({ length: 128 }, (_, index) =>
    Object.freeze({ ...rectangle(), id: String(index) }),
  );
  const value = { ...snapshot(), elements };
  let visited = 0;
  const cache = new CanonicalMetadataCache((element) => {
    visited += 1;
    return Object.isFrozen(element);
  });
  await cache.digest(value, checkpoint);
  visited = 0;
  const abort = new AbortController();
  let checkpoints = 0;
  await expect(
    cache.digest(
      value,
      async () => {
        checkpoints += 1;
        abort.abort();
      },
      abort.signal,
    ),
  ).rejects.toThrow();
  expect(checkpoints).toBe(1);
  expect(visited).toBeLessThanOrEqual(64);
});

it("does not retain an element whose ownership ends while encoding yields", async () => {
  const element = Object.freeze(rectangle());
  const value = { ...snapshot(), elements: [element] };
  let owned: typeof element | null = element;
  const cache = new CanonicalMetadataCache((candidate) => candidate === owned);
  let resume: () => void = () => undefined;
  let notifyStarted: () => void = () => undefined;
  const paused = new Promise<void>((resolve) => (resume = resolve));
  const started = new Promise<void>((resolve) => (notifyStarted = resolve));
  let first = true;
  const digest = cache.digest(value, () => {
    if (!first) return Promise.resolve();
    first = false;
    notifyStarted();
    return paused;
  });
  await started;
  owned = null;
  resume();
  await expect(digest).resolves.toBe(canonicalMetadataSha256(value));
  owned = element;
  const canonicalize = vi.spyOn(canonical, "canonicalElement");
  await cache.digest(value, checkpoint);
  expect(canonicalize).toHaveBeenCalledOnce();
});

it("copies mixed small and large cached fragments in at most 64 KiB per checkpoint", async () => {
  const points = Array.from({ length: 16_384 * 3 }, (_, index) => [10, 20, 0.5][index % 3]!);
  const stroke = Object.freeze({
    ...createTestStroke(),
    id: "00000000-0000-4000-8000-000000000002",
    points,
  });
  const value = { ...snapshot(), elements: [Object.freeze(rectangle()), stroke] };
  const cache = new CanonicalMetadataCache(Object.isFrozen);
  await cache.digest(value, checkpoint);
  const expected = canonicalMetadataSha256(value);
  const originalSet = Reflect.get(Uint8Array.prototype, "set");
  let copied = 0;
  const copiedBetweenCheckpoints: number[] = [];
  const copy = vi.spyOn(Uint8Array.prototype, "set").mockImplementation(function (
    this: Uint8Array,
    source,
    offset,
  ) {
    if (this.byteLength > 64 * 1024) copied += source.length;
    originalSet.call(this, source, offset);
  });
  try {
    const actual = await cache.digest(value, async () => {
      if (copied === 0) return;
      copiedBetweenCheckpoints.push(copied);
      copied = 0;
    });
    expect(actual).toBe(expected);
    expect(copiedBetweenCheckpoints.length).toBeGreaterThan(1);
    expect(Math.max(...copiedBetweenCheckpoints)).toBeLessThanOrEqual(64 * 1024);
  } finally {
    copy.mockRestore();
  }
});
