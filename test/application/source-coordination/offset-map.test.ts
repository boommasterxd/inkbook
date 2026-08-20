import { describe, expect, it } from "vitest";

import {
  composeSourceOffsetMaps,
  identifySourceOffsetMap,
  mapSourceOffset,
  validateSourceOffsetMap,
} from "../../../src/application/source-coordination/offset-map";
import {
  digestMarkdownSnapshot,
  preflightSourceSnapshot,
  SOURCE_COORDINATION_LIMITS_V1,
} from "../../../src/application/source-coordination/limits";
import { TestStreamingDigestPort, digestUtf8 } from "./support";

/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact UTF-16 positions are the canonical map fixtures under test. */

describe("source offset map validation", () => {
  it("accepts canonical replacements, insertions, and deletions immutably", () => {
    const spans = [
      { oldFromUtf16: 2, oldToUtf16: 4, newFromUtf16: 2, newToUtf16: 5 },
      { oldFromUtf16: 6, oldToUtf16: 7, newFromUtf16: 7, newToUtf16: 7 },
    ];
    const result = validateSourceOffsetMap({ spans }, 9, 9);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.spans)).toBe(true);
    expect(result.value.spans).not.toBe(spans);
  });

  it.each([
    [{ spans: [] }, 1, 2],
    [
      {
        spans: [
          { oldFromUtf16: -1, oldToUtf16: 0, newFromUtf16: 0, newToUtf16: 0 },
        ],
      },
      1,
      1,
    ],
    [
      {
        spans: [
          { oldFromUtf16: 2, oldToUtf16: 1, newFromUtf16: 1, newToUtf16: 2 },
        ],
      },
      2,
      2,
    ],
    [
      {
        spans: [
          { oldFromUtf16: 0, oldToUtf16: 1, newFromUtf16: 0, newToUtf16: 1 },
          { oldFromUtf16: 1, oldToUtf16: 2, newFromUtf16: 1, newToUtf16: 2 },
        ],
      },
      2,
      2,
    ],
    [
      {
        spans: [
          { oldFromUtf16: 1, oldToUtf16: 2, newFromUtf16: 2, newToUtf16: 3 },
        ],
      },
      3,
      4,
    ],
  ] as const)(
    "rejects non-canonical map %#",
    (map, priorLength, replacementLength) => {
      expect(
        validateSourceOffsetMap(map, priorLength, replacementLength).ok,
      ).toBe(false);
    },
  );
});

describe("source offset map boundary validation", () => {
  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an unsafe prior length %s without throwing",
    (priorLength) => {
      expect(validateSourceOffsetMap({ spans: [] }, priorLength, 0)).toEqual({
        ok: false,
        code: "resource-limit",
      });
    },
  );

  it.each([
    null,
    {},
    { spans: "not-an-array" },
    { spans: [], unexpected: true },
    {
      spans: [
        {
          newFromUtf16: 0,
          newToUtf16: 0,
          oldFromUtf16: 0,
          oldToUtf16: 0,
          unexpected: true,
        },
      ],
    },
  ])("rejects a malformed or open map boundary %#", (map) => {
    expect(validateSourceOffsetMap(map, 0, 0)).toEqual({
      ok: false,
      code: "invalid-command",
    });
  });

  it("preflights the changed-span count before materialization", () => {
    const excessiveSpans = new Array(65_537).fill({
      newFromUtf16: 0,
      newToUtf16: 0,
      oldFromUtf16: 0,
      oldToUtf16: 0,
    });

    expect(validateSourceOffsetMap({ spans: excessiveSpans }, 0, 0)).toEqual({
      ok: false,
      code: "resource-limit",
    });
  });
});

describe("source offset map boundary hardening", () => {
  it("rejects a closed zero-length no-op span", () => {
    expect(
      validateSourceOffsetMap(
        {
          spans: [
            {
              newFromUtf16: 0,
              newToUtf16: 0,
              oldFromUtf16: 0,
              oldToUtf16: 0,
            },
          ],
        },
        0,
        0,
      ),
    ).toEqual({ ok: false, code: "invalid-command" });
  });

  it("rejects foreign prototypes and hidden or symbolic extras", () => {
    const foreignMap = Object.create({ inherited: true }) as {
      spans: unknown[];
    };
    foreignMap.spans = [];
    const symbolMap = { spans: [] as unknown[] };
    Object.defineProperty(symbolMap, Symbol("hidden"), { value: true });
    const hiddenSpan = {
      newFromUtf16: 0,
      newToUtf16: 1,
      oldFromUtf16: 0,
      oldToUtf16: 0,
    };
    Object.defineProperty(hiddenSpan, "hidden", {
      enumerable: false,
      value: true,
    });

    expect(validateSourceOffsetMap(foreignMap, 0, 0)).toEqual({
      ok: false,
      code: "invalid-command",
    });
    expect(validateSourceOffsetMap(symbolMap, 0, 0)).toEqual({
      ok: false,
      code: "invalid-command",
    });
    expect(validateSourceOffsetMap({ spans: [hiddenSpan] }, 0, 1)).toEqual({
      ok: false,
      code: "invalid-command",
    });
  });

  it("rejects accessor records without executing their getters", () => {
    let getterCalls = 0;
    const accessorMap = {
      get spans(): readonly unknown[] {
        getterCalls += 1;
        return [];
      },
    };
    expect(validateSourceOffsetMap(accessorMap, 0, 0)).toEqual({
      ok: false,
      code: "invalid-command",
    });

    const accessorSpan = {
      get newFromUtf16(): number {
        getterCalls += 1;
        return 0;
      },
      newToUtf16: 0,
      oldFromUtf16: 0,
      oldToUtf16: 0,
    };
    expect(validateSourceOffsetMap({ spans: [accessorSpan] }, 0, 0)).toEqual({
      ok: false,
      code: "invalid-command",
    });
    expect(getterCalls).toBe(0);
  });
});

describe("source offset map byte admission", () => {
  it("stops materializing spans when the encoded-byte limit is reached", () => {
    const spanCount = SOURCE_COORDINATION_LIMITS_V1.maxChangedSpans;
    const spans = Array.from({ length: spanCount }, (_, index) => ({
      newFromUtf16: index * 2,
      newToUtf16: index * 2 + 1,
      oldFromUtf16: index,
      oldToUtf16: index,
    }));
    let finalGetterCalls = 0;
    Object.defineProperty(spans, spanCount - 1, {
      enumerable: true,
      get: () => {
        finalGetterCalls += 1;
        return spans[0];
      },
    });

    expect(
      validateSourceOffsetMap({ spans }, spanCount, spanCount * 2),
    ).toEqual({ ok: false, code: "resource-limit" });
    expect(finalGetterCalls).toBe(0);
  });
});

describe("source offset mapping and composition", () => {
  const insertion = {
    spans: [
      {
        newFromUtf16: 2,
        newToUtf16: 3,
        oldFromUtf16: 2,
        oldToUtf16: 2,
      },
    ],
  };

  it("maps insertion boundaries with before and after association", () => {
    expect(mapSourceOffset(insertion, 4, 5, 2, "before")).toEqual({
      ok: true,
      value: 2,
    });
    expect(mapSourceOffset(insertion, 4, 5, 2, "after")).toEqual({
      ok: true,
      value: 3,
    });
    expect(mapSourceOffset(insertion, 4, 5, 4, "after")).toEqual({
      ok: true,
      value: 5,
    });
  });

  it("composes ordered edits into one canonical minimal map", () => {
    const second = {
      spans: [
        {
          newFromUtf16: 3,
          newToUtf16: 4,
          oldFromUtf16: 3,
          oldToUtf16: 3,
        },
      ],
    };
    const result = composeSourceOffsetMaps(insertion, second, 4, 5, 6);
    expect(result).toEqual({
      ok: true,
      value: {
        spans: [
          {
            newFromUtf16: 2,
            newToUtf16: 4,
            oldFromUtf16: 2,
            oldToUtf16: 2,
          },
        ],
      },
    });
  });

  it("preflights the composition owner limit before candidates", () => {
    const spanCount = SOURCE_COORDINATION_LIMITS_V1.maxChangedSpans / 2 + 1;
    const first = {
      spans: Array.from({ length: spanCount }, (_, index) => ({
        newFromUtf16: index * 2,
        newToUtf16: index * 2 + 1,
        oldFromUtf16: index,
        oldToUtf16: index,
      })),
    };
    const second = {
      spans: Array.from({ length: spanCount }, (_, index) => ({
        newFromUtf16: index * 3,
        newToUtf16: index * 3 + 1,
        oldFromUtf16: index * 2,
        oldToUtf16: index * 2,
      })),
    };

    expect(
      composeSourceOffsetMaps(
        first,
        second,
        spanCount,
        spanCount * 2,
        spanCount * 3,
      ),
    ).toEqual({ ok: false, code: "resource-limit" });
  });
});

describe("source map and Markdown streaming digests", () => {
  it("digests canonical map bytes without a complete canonical string", async () => {
    const port = new TestStreamingDigestPort();
    const map = {
      spans: [
        {
          newFromUtf16: 1,
          newToUtf16: 2,
          oldFromUtf16: 1,
          oldToUtf16: 1,
        },
      ],
    };
    const result = await identifySourceOffsetMap(port, map, 3, 4);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const canonical =
      '{"priorUtf16Length":3,"replacementUtf16Length":4,"spans":[{"newFromUtf16":1,"newToUtf16":2,"oldFromUtf16":1,"oldToUtf16":1}]}';
    expect(result.value.digest).toBe(digestUtf8(canonical));
    expect(result.value.encodedBytes).toBe(
      new TextEncoder().encode(canonical).byteLength,
    );
  });

  it("streams multibyte and astral Markdown in bounded chunks", async () => {
    const markdown = `prefix-${"€😀".repeat(100_000)}-suffix`;
    const admission = preflightSourceSnapshot(markdown);
    expect(admission.ok).toBe(true);
    if (!admission.ok) return;
    const snapshot = Object.freeze({
      markdown,
      retainedBytes: admission.value.retainedBytes,
      utf16Length: admission.value.utf16Length,
      utf8Bytes: admission.value.utf8Bytes,
    });
    const port = new TestStreamingDigestPort();
    const result = await digestMarkdownSnapshot(port, snapshot);
    expect(result).toEqual({ ok: true, value: digestUtf8(markdown) });
    expect(Math.max(...port.chunkSizes)).toBeLessThanOrEqual(
      SOURCE_COORDINATION_LIMITS_V1.maxStreamingDigestChunkBytes,
    );
  });

  it("preserves a surrogate pair across the digest chunk boundary", async () => {
    const markdown = `${"a".repeat(65_535)}😀tail`;
    const admission = preflightSourceSnapshot(markdown);
    expect(admission.ok).toBe(true);
    if (!admission.ok) return;
    const snapshot = Object.freeze({
      markdown,
      retainedBytes: admission.value.retainedBytes,
      utf16Length: admission.value.utf16Length,
      utf8Bytes: admission.value.utf8Bytes,
    });
    const port = new TestStreamingDigestPort();

    expect(await digestMarkdownSnapshot(port, snapshot)).toEqual({
      ok: true,
      value: digestUtf8(markdown),
    });
    expect(port.chunkSizes).toHaveLength(2);
    expect(Math.max(...port.chunkSizes)).toBeLessThanOrEqual(
      SOURCE_COORDINATION_LIMITS_V1.maxStreamingDigestChunkBytes,
    );
  });
});
