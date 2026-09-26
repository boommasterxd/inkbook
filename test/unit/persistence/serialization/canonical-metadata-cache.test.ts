import { afterEach, describe, expect, it, vi } from "vitest";
import { CanonicalMetadataCache } from "../../../../src/persistence/serialization/canonical-metadata-cache";
import { canonicalMetadataSha256 } from "../../../../src/persistence/serialization/canonical-metadata";
import * as canonical from "../../../../src/persistence/serialization/canonical-snapshot";
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
