import { describe, expect, it } from "vitest";

import { validateSourceOffsetMap } from "../../../src/application/source-coordination";

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
