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
    const result = validateSourceCheckpointChain(ROOT, [checkpoint()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
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
