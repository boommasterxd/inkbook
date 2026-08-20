/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact chunk and source limits define the fixtures. */
import { describe, expect, it } from "vitest";

import {
  commandSuccess,
  parseSha256Digest,
} from "../../../src/application/note-session";
import {
  digestImmutableSourceDocumentV1,
  materializeImmutableSourceDocumentV1,
  preflightImmutableSourceDocumentV1,
  SOURCE_COORDINATION_LIMITS_V1,
  type ImmutableSourceDocumentV1,
} from "../../../src/application/source-coordination";
import type {
  SourceDigestWorkPortV1,
  SourceDigestWorkSubmissionV1,
} from "../../../src/application/source-coordination/work-ports";

const DIGEST = parseSha256Digest("a".repeat(64));

describe("immutable source documents", () => {
  it("rejects an oversized capability before reading it", () => {
    let reads = 0;
    const document: ImmutableSourceDocumentV1 = {
      sliceString: (): string => {
        reads += 1;
        return "";
      },
      utf16Length: SOURCE_COORDINATION_LIMITS_V1.maxMarkdownUtf16Length + 1,
    };

    expect(preflightImmutableSourceDocumentV1(document)).toEqual({
      code: "resource-limit",
      ok: false,
    });
    expect(reads).toBe(0);
  });

  it("streams worker chunks strictly in sequence without a full-string read", async () => {
    const markdown = "a".repeat(600_000);
    let fullReads = 0;
    const document: ImmutableSourceDocumentV1 = {
      sliceString: (fromUtf16, toUtf16): string => {
        if (fromUtf16 === 0 && toUtf16 === markdown.length) fullReads += 1;
        return markdown.slice(fromUtf16, toUtf16);
      },
      utf16Length: markdown.length,
    };
    const port = new SequentialDigestPort();

    await expect(
      digestImmutableSourceDocumentV1(document, port),
    ).resolves.toEqual({ ok: true, value: DIGEST });
    expect(port.maximumActiveUpdates).toBe(1);
    expect(port.updates).toBeGreaterThan(1);
    expect(fullReads).toBe(0);
  });

  it("materializes one exact replacement only when requested", () => {
    const markdown = "Markdown";
    const result = materializeImmutableSourceDocumentV1({
      sliceString: (fromUtf16, toUtf16) => markdown.slice(fromUtf16, toUtf16),
      utf16Length: markdown.length,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { markdown, utf16Length: markdown.length },
    });
  });
});

class SequentialDigestPort implements SourceDigestWorkPortV1 {
  #activeUpdates = 0;
  maximumActiveUpdates = 0;
  updates = 0;

  public submit(): SourceDigestWorkSubmissionV1 {
    let resolve!: (
      result: ReturnType<typeof commandSuccess<typeof DIGEST>>,
    ) => void;
    const completion = new Promise<
      ReturnType<typeof commandSuccess<typeof DIGEST>>
    >((settle) => {
      resolve = settle;
    });
    return {
      cancel: (): void => undefined,
      closeInput: (): void => resolve(commandSuccess(DIGEST)),
      completion,
      update: async (): Promise<void> => {
        this.#activeUpdates += 1;
        this.maximumActiveUpdates = Math.max(
          this.maximumActiveUpdates,
          this.#activeUpdates,
        );
        this.updates += 1;
        await Promise.resolve();
        this.#activeUpdates -= 1;
      },
    };
  }
}
