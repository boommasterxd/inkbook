import { describe, expect, it } from "vitest";

import {
  createSourceMapFallbackWorkV1,
  validateAndNormalizeSourceMapCompositionRequestV1,
} from "../../../src/application/source-coordination/map-composition-fallback";
import { composeSourceMapCompositionRequest } from "../../../src/application/source-coordination/map-graph";
import { SOURCE_COORDINATION_LIMITS_V1 } from "../../../src/application/source-coordination/limits";
import type {
  NormalizedSourceMapCompositionRequestV1,
  SourceMapCompositionRequestV1,
} from "../../../src/application/source-coordination/work-ports";

/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact offsets and slice counts define composition boundaries. */

function request(): SourceMapCompositionRequestV1 {
  return {
    priorUtf16Length: 3,
    replacementUtf16Length: 5,
    scratchByteLimit: 8 * 1024 * 1024,
    segments: [
      {
        offsetMap: {
          spans: [
            {
              newFromUtf16: 1,
              newToUtf16: 2,
              oldFromUtf16: 1,
              oldToUtf16: 1,
            },
          ],
        },
        priorUtf16Length: 3,
        replacementUtf16Length: 4,
      },
      {
        offsetMap: {
          spans: [
            {
              newFromUtf16: 2,
              newToUtf16: 3,
              oldFromUtf16: 2,
              oldToUtf16: 2,
            },
          ],
        },
        priorUtf16Length: 4,
        replacementUtf16Length: 5,
      },
    ],
    wireVersion: 1,
  };
}

function normalize(): NormalizedSourceMapCompositionRequestV1 {
  const result = validateAndNormalizeSourceMapCompositionRequestV1(request());
  if (!result.ok) throw new Error("Expected normalized source map work.");
  return result.value;
}

describe("source map fallback work", () => {
  it("matches canonical composition across resumable processing units", () => {
    const normalized = normalize();
    const expected = composeSourceMapCompositionRequest(normalized);
    const work = createSourceMapFallbackWorkV1(normalized);
    let resumes = 0;
    let result: ReturnType<typeof work.resume>;
    do {
      resumes += 1;
      let checks = 0;
      result = work.resume({
        shouldYield: () => {
          checks += 1;
          return checks > 2;
        },
      });
    } while (result.ok && result.value.kind === "pending");
    expect(result).toEqual(
      expected.ok
        ? { ok: true, value: { kind: "completed", offsetMap: expected.value } }
        : expected,
    );
    expect(resumes).toBeGreaterThan(0);
  });

  it("fails closed for untrusted records and a disconnected segment", () => {
    const withSymbol = request() as SourceMapCompositionRequestV1 &
      Record<symbol, boolean>;
    withSymbol[Symbol("extra")] = true;
    expect(
      validateAndNormalizeSourceMapCompositionRequestV1(withSymbol),
    ).toEqual({ ok: false, code: "invalid-command" });
    expect(
      validateAndNormalizeSourceMapCompositionRequestV1({
        ...request(),
        replacementUtf16Length: 6,
        segments: [
          request().segments[0],
          {
            ...request().segments[1],
            priorUtf16Length: 5,
            replacementUtf16Length: 6,
          },
        ],
      }),
    ).toEqual({ ok: false, code: "stale-source" });

    const segmentsWithSymbol = [...request().segments] as unknown[] &
      Record<symbol, boolean>;
    segmentsWithSymbol[Symbol("extra")] = true;
    expect(
      validateAndNormalizeSourceMapCompositionRequestV1({
        ...request(),
        segments: segmentsWithSymbol,
      }),
    ).toEqual({ ok: false, code: "invalid-command" });
  });

  it("enforces scratch admission and cancellation on resume", () => {
    const tooSmall = validateAndNormalizeSourceMapCompositionRequestV1({
      ...request(),
      scratchByteLimit: 1,
    });
    expect(tooSmall.ok).toBe(true);
    if (!tooSmall.ok) return;
    expect(
      createSourceMapFallbackWorkV1(tooSmall.value).resume({
        shouldYield: () => false,
      }),
    ).toEqual({ ok: false, code: "resource-limit" });

    const cancelled = createSourceMapFallbackWorkV1(normalize());
    cancelled.cancel();
    expect(cancelled.resume({ shouldYield: () => false })).toEqual({
      ok: false,
      code: "disposed",
    });
  });

  it("rejects an above-limit candidate owner bound before composition", () => {
    const normalized = normalize();
    const first = normalized.segments[0];
    const second = normalized.segments[1];
    if (first === undefined || second === undefined) {
      throw new Error("Expected two source-map segments.");
    }
    const oversized = {
      ...normalized,
      segments: [
        {
          ...first,
          offsetMap: {
            spans: new Array(SOURCE_COORDINATION_LIMITS_V1.maxChangedSpans),
          },
        },
        second,
      ],
    } as NormalizedSourceMapCompositionRequestV1;
    expect(
      createSourceMapFallbackWorkV1(oversized).resume({
        shouldYield: () => false,
      }),
    ).toEqual({ ok: false, code: "resource-limit" });
  });
});
