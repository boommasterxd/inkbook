import { describe, expect, it } from "vitest";

import {
  createSessionOrder,
  createSidecarRevision,
  createSourceGeneration,
  parseSha256Digest,
  parseSourceCheckpointId,
} from "../../../src/application/note-session";
import {
  validateSourceCheckpointChain,
  recoverSourceCheckpointChain,
  type SourceCheckpointOperationV1,
  type SourceCheckpointRootV1,
} from "../../../src/application/source-coordination";

/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact generations and UTF-16 lengths define checkpoint continuity. */

const PAYLOAD = "00000000000000000000000000";
const DIGEST_LENGTH = 64;
const DIGEST_A = parseSha256Digest("a".repeat(DIGEST_LENGTH));
const DIGEST_B = parseSha256Digest("b".repeat(DIGEST_LENGTH));
const BASE = {
  markdownPath: "notes/source.md",
  rawTextSha256: DIGEST_A,
  revision: createSidecarRevision(1),
  vaultRelativePath: "notes/source.inkbook.json",
};
const ROOT: SourceCheckpointRootV1 = {
  base: BASE,
  digest: DIGEST_A,
  generation: createSourceGeneration(1),
  utf16Length: 4,
};

function checkpoint(
  overrides: Partial<SourceCheckpointOperationV1> = {},
): SourceCheckpointOperationV1 {
  return {
    base: BASE,
    checkpointId: parseSourceCheckpointId(`scp_${PAYLOAD}`),
    offsetMap: {
      spans: [
        {
          newFromUtf16: 1,
          newToUtf16: 3,
          oldFromUtf16: 1,
          oldToUtf16: 2,
        },
      ],
    },
    priorDigest: DIGEST_A,
    priorGeneration: createSourceGeneration(1),
    priorUtf16Length: 4,
    replacementDigest: DIGEST_B,
    replacementGeneration: createSourceGeneration(2),
    replacementUtf16Length: 5,
    sessionOrder: createSessionOrder(1),
    ...overrides,
  };
}

describe("source checkpoint chain validation", () => {
  it("accepts and freezes a contiguous canonical chain", () => {
    const candidate = checkpoint();
    const result = validateSourceCheckpointChain(ROOT, [candidate]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const suppliedSpan = candidate.offsetMap.spans[0] as {
      newToUtf16: number;
    };
    suppliedSpan.newToUtf16 = 4;
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value[0])).toBe(true);
    expect(Object.isFrozen(result.value[0]?.offsetMap)).toBe(true);
    expect(Object.isFrozen(result.value[0]?.offsetMap.spans)).toBe(true);
    expect(result.value[0]?.offsetMap.spans[0]?.newToUtf16).toBe(3);
    expect(result.value[0]).not.toBeUndefined();
  });

  it.each([
    checkpoint({ priorDigest: DIGEST_B }),
    checkpoint({ priorUtf16Length: 3 }),
    checkpoint({ replacementGeneration: createSourceGeneration(3) }),
    checkpoint({ base: { ...BASE, markdownPath: "notes/other.md" } }),
    checkpoint({ offsetMap: { spans: [] } }),
  ])("rejects non-contiguous checkpoint %#", (candidate) => {
    expect(validateSourceCheckpointChain(ROOT, [candidate])).toEqual({
      ok: false,
      code: "recovery-unavailable",
    });
  });

  it("rejects duplicate checkpoint identity and non-increasing order", () => {
    const first = checkpoint();
    const second = checkpoint({
      priorDigest: DIGEST_B,
      priorGeneration: createSourceGeneration(2),
      priorUtf16Length: 5,
      replacementGeneration: createSourceGeneration(3),
      sessionOrder: createSessionOrder(1),
    });
    expect(validateSourceCheckpointChain(ROOT, [first, second]).ok).toBe(false);
  });
});

describe("bounded source checkpoint recovery", () => {
  it("selects one contiguous chain through the exact current digest", () => {
    const first = checkpoint();
    const second = checkpoint({
      checkpointId: parseSourceCheckpointId(`scp_1${PAYLOAD.slice(1)}`),
      offsetMap: {
        spans: [
          {
            newFromUtf16: 5,
            newToUtf16: 6,
            oldFromUtf16: 5,
            oldToUtf16: 5,
          },
        ],
      },
      priorDigest: DIGEST_B,
      priorGeneration: createSourceGeneration(2),
      priorUtf16Length: 5,
      replacementDigest: parseSha256Digest("c".repeat(DIGEST_LENGTH)),
      replacementGeneration: createSourceGeneration(3),
      replacementUtf16Length: 6,
      sessionOrder: createSessionOrder(2),
    });
    const result = recoverSourceCheckpointChain(ROOT, [second, first], {
      digest: second.replacementDigest,
      utf16Length: second.replacementUtf16Length,
    });
    expect(result).toEqual({ ok: true, value: [first, second] });
  });

  it("rejects gaps, forks, and a target unrelated to the chain", () => {
    const first = checkpoint();
    const fork = checkpoint({
      checkpointId: parseSourceCheckpointId(`scp_1${PAYLOAD.slice(1)}`),
      replacementDigest: parseSha256Digest("d".repeat(DIGEST_LENGTH)),
    });
    expect(
      recoverSourceCheckpointChain(ROOT, [first, fork], {
        digest: DIGEST_B,
        utf16Length: 5,
      }),
    ).toEqual({ ok: false, code: "recovery-unavailable" });
    expect(
      recoverSourceCheckpointChain(ROOT, [first], {
        digest: parseSha256Digest("e".repeat(DIGEST_LENGTH)),
        utf16Length: 5,
      }),
    ).toEqual({ ok: false, code: "recovery-unavailable" });
  });

  it("rejects duplicate checkpoint order during recovery", () => {
    const first = checkpoint();
    const second = checkpoint({
      checkpointId: parseSourceCheckpointId(`scp_1${PAYLOAD.slice(1)}`),
      offsetMap: {
        spans: [
          {
            newFromUtf16: 5,
            newToUtf16: 6,
            oldFromUtf16: 5,
            oldToUtf16: 5,
          },
        ],
      },
      priorDigest: DIGEST_B,
      priorGeneration: createSourceGeneration(2),
      priorUtf16Length: 5,
      replacementDigest: parseSha256Digest("c".repeat(DIGEST_LENGTH)),
      replacementGeneration: createSourceGeneration(3),
      replacementUtf16Length: 6,
      sessionOrder: createSessionOrder(1),
    });

    expect(
      recoverSourceCheckpointChain(ROOT, [second, first], {
        digest: second.replacementDigest,
        utf16Length: second.replacementUtf16Length,
      }),
    ).toEqual({ ok: false, code: "recovery-unavailable" });
  });

  it("uses no checkpoint when current Markdown exactly matches the root", () => {
    expect(
      recoverSourceCheckpointChain(ROOT, [checkpoint()], {
        digest: ROOT.digest,
        utf16Length: ROOT.utf16Length,
      }),
    ).toEqual({ ok: true, value: [] });
  });
});
