/* eslint-disable @typescript-eslint/no-magic-numbers -- Source limits are the behavior under test. */
import { describe, expect, it } from "vitest";

import {
  digestImmutableSourceDocumentV1,
  immutableSourceDocumentRetainedBytesV1,
  materializeImmutableSourceDocumentV1,
  preflightImmutableSourceDocumentV1,
  SOURCE_COORDINATION_LIMITS_V1,
  type ImmutableSourceDocumentV1,
} from "../../../src/application/source-coordination";
import type {
  CommandResultV1,
  Sha256Digest,
} from "../../../src/application/note-session";
import type {
  SourceDigestWorkPortV1,
  SourceDigestWorkSubmissionV1,
} from "../../../src/application/source-coordination/work-ports";
import { digestUtf8 } from "./support";

const DIGEST = digestUtf8("document");

function documentFor(markdown: string): ImmutableSourceDocumentV1 {
  return {
    sliceString: (fromUtf16, toUtf16) => markdown.slice(fromUtf16, toUtf16),
    utf16Length: markdown.length,
  };
}

describe("immutable source document admission branches", () => {
  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    SOURCE_COORDINATION_LIMITS_V1.maxMarkdownUtf16Length + 1,
  ])("rejects an invalid UTF-16 capability (%s)", (utf16Length) => {
    expect(
      preflightImmutableSourceDocumentV1({
        sliceString: () => "unread",
        utf16Length,
      }),
    ).toEqual({ ok: false, code: "resource-limit" });
  });

  it("rejects a source whose slice throws or changes its advertised length", () => {
    expect(
      preflightImmutableSourceDocumentV1({
        sliceString: () => {
          throw new Error("source was disposed");
        },
        utf16Length: 1,
      }),
    ).toEqual({ ok: false, code: "resource-limit" });
    expect(
      preflightImmutableSourceDocumentV1({
        sliceString: () => "",
        utf16Length: 1,
      }),
    ).toEqual({ ok: false, code: "resource-limit" });
  });

  it("admits empty and newline-terminated documents", () => {
    expect(preflightImmutableSourceDocumentV1(documentFor(""))).toEqual({
      ok: true,
      value: { utf8Bytes: 0 },
    });
    expect(preflightImmutableSourceDocumentV1(documentFor("one\n\n"))).toEqual({
      ok: true,
      value: { utf8Bytes: 5 },
    });
  });

  it("rejects a source block that exceeds its bounded length", () => {
    const markdown = "x".repeat(
      SOURCE_COORDINATION_LIMITS_V1.maxSourceBlockUtf16Length + 1,
    );
    expect(preflightImmutableSourceDocumentV1(documentFor(markdown))).toEqual({
      ok: false,
      code: "resource-limit",
    });
  });

  it("rejects a source with too many separated blocks", () => {
    const markdown = "x\n\n".repeat(
      SOURCE_COORDINATION_LIMITS_V1.maxSourceBlocks + 1,
    );
    expect(preflightImmutableSourceDocumentV1(documentFor(markdown))).toEqual({
      ok: false,
      code: "resource-limit",
    });
  });

  it("counts non-ASCII UTF-8 bytes and rejects the encoded-byte limit", () => {
    const markdown = "\u0800".repeat(5_600_000);
    expect(markdown.length).toBeLessThan(
      SOURCE_COORDINATION_LIMITS_V1.maxMarkdownUtf16Length,
    );
    expect(preflightImmutableSourceDocumentV1(documentFor(markdown))).toEqual({
      ok: false,
      code: "resource-limit",
    });
  });
});

describe("immutable source document chunk boundaries", () => {
  it("keeps a surrogate pair together when a chunk ends at its high surrogate", () => {
    const markdown = `${"a".repeat(65_535)}😀${"b".repeat(12)}`;
    const slices: (readonly [number, number])[] = [];
    const result = preflightImmutableSourceDocumentV1({
      sliceString: (fromUtf16, toUtf16) => {
        slices.push([fromUtf16, toUtf16]);
        return markdown.slice(fromUtf16, toUtf16);
      },
      utf16Length: markdown.length,
    });

    expect(result).toEqual({
      ok: true,
      value: { utf8Bytes: markdown.length + 2 },
    });
    expect(slices).toEqual([
      [65_535, 65_537],
      [0, 65_535],
      [65_535, markdown.length],
    ]);
    expect(immutableSourceDocumentRetainedBytesV1(documentFor(markdown))).toBe(
      markdown.length * 2,
    );
  });

  it("treats a malformed chunk edge as a non-surrogate boundary", () => {
    const markdown = "a".repeat(70_000);
    expect(
      preflightImmutableSourceDocumentV1({
        sliceString: (fromUtf16, toUtf16) =>
          fromUtf16 === 65_535 && toUtf16 === 65_537
            ? "a"
            : markdown.slice(fromUtf16, toUtf16),
        utf16Length: markdown.length,
      }),
    ).toEqual({ ok: true, value: { utf8Bytes: markdown.length } });
  });
});

describe("immutable source document digest branches", () => {
  it("uses the local sink for small documents and reports an early abort", async () => {
    const document = documentFor("document");
    await expect(
      digestImmutableSourceDocumentV1(document, new ThrowingDigestPort()),
    ).resolves.toEqual({ ok: true, value: digestUtf8("document") });

    const controller = new AbortController();
    controller.abort();
    await expect(
      digestImmutableSourceDocumentV1(
        document,
        new ThrowingDigestPort(),
        controller.signal,
      ),
    ).resolves.toEqual({ ok: false, code: "disposed" });
  });

  it("uses the worker sink and closes it after all chunks", async () => {
    const markdown = "a".repeat(600_000);
    const port = new ControlledDigestPort({ digest: digestUtf8(markdown) });

    await expect(
      digestImmutableSourceDocumentV1(documentFor(markdown), port),
    ).resolves.toEqual({ ok: true, value: digestUtf8(markdown) });
    expect(port.submissions).toBe(1);
    expect(port.updates).toBeGreaterThan(1);
    expect(port.closed).toBe(true);
    expect(port.cancelled).toBe(0);
  });

  it("returns the admission failure before selecting a digest sink", async () => {
    const document: ImmutableSourceDocumentV1 = {
      sliceString: () => "",
      utf16Length: SOURCE_COORDINATION_LIMITS_V1.maxMarkdownUtf16Length + 1,
    };

    await expect(
      digestImmutableSourceDocumentV1(
        document,
        new ThrowingDigestPort("submit"),
      ),
    ).resolves.toEqual({ ok: false, code: "resource-limit" });
  });

  it("maps worker submission, update, and completion failures", async () => {
    const markdown = "a".repeat(600_000);
    await expect(
      digestImmutableSourceDocumentV1(
        documentFor(markdown),
        new ThrowingDigestPort("submit"),
      ),
    ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });

    const updateFailure = new ControlledDigestPort({ updateError: true });
    await expect(
      digestImmutableSourceDocumentV1(documentFor(markdown), updateFailure),
    ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });
    expect(updateFailure.cancelled).toBe(1);

    const failedCompletion = new ControlledDigestPort({
      completion: { ok: false, code: "recovery-unavailable" },
    });
    await expect(
      digestImmutableSourceDocumentV1(documentFor(markdown), failedCompletion),
    ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });
    expect(failedCompletion.cancelled).toBe(1);
  });

  it("returns disposed when an abort arrives during the final update", async () => {
    const markdown = "a".repeat(600_000);
    const controller = new AbortController();
    const port = new ControlledDigestPort({
      abortAfterBytes: markdown.length,
      onBytes: (bytes): void => {
        if (bytes >= markdown.length) controller.abort();
      },
    });

    await expect(
      digestImmutableSourceDocumentV1(
        documentFor(markdown),
        port,
        controller.signal,
      ),
    ).resolves.toEqual({ ok: false, code: "disposed" });
    expect(port.closed).toBe(false);
    expect(port.cancelled).toBe(1);
  });

  it("maps an abort observed at the next chunk to disposed", async () => {
    const markdown = "a".repeat(600_000);
    const controller = new AbortController();
    const port = new ControlledDigestPort({
      onBytes: (): void => controller.abort(),
    });

    await expect(
      digestImmutableSourceDocumentV1(
        documentFor(markdown),
        port,
        controller.signal,
      ),
    ).resolves.toEqual({ ok: false, code: "disposed" });
    expect(port.cancelled).toBe(1);
  });
});

describe("immutable source document materialization branches", () => {
  it("returns stale-source when materialization is short or throws", () => {
    let shortReads = 0;
    expect(
      materializeImmutableSourceDocumentV1({
        sliceString: () => {
          shortReads += 1;
          return shortReads === 1 ? "valid!" : "short";
        },
        utf16Length: 6,
      }),
    ).toEqual({ ok: false, code: "stale-source" });
    let throwingReads = 0;
    expect(
      materializeImmutableSourceDocumentV1({
        sliceString: () => {
          throwingReads += 1;
          if (throwingReads === 1) return "valid!";
          throw new Error("disposed");
        },
        utf16Length: 6,
      }),
    ).toEqual({ ok: false, code: "stale-source" });
  });

  it("propagates admission failures without reading the source", () => {
    let reads = 0;
    expect(
      materializeImmutableSourceDocumentV1({
        sliceString: () => {
          reads += 1;
          return "";
        },
        utf16Length: SOURCE_COORDINATION_LIMITS_V1.maxMarkdownUtf16Length + 1,
      }),
    ).toEqual({ ok: false, code: "resource-limit" });
    expect(reads).toBe(0);
  });
});

interface ControlledDigestOptions {
  readonly abortAfterBytes?: number;
  readonly completion?: CommandResultV1<Sha256Digest>;
  readonly digest?: Sha256Digest;
  readonly onBytes?: (bytes: number) => void;
  readonly updateError?: boolean;
}

class ControlledDigestPort implements SourceDigestWorkPortV1 {
  public closed = false;
  public cancelled = 0;
  public submissions = 0;
  public updates = 0;
  #bytes = 0;
  readonly #options: ControlledDigestOptions;

  public constructor(options: ControlledDigestOptions = {}) {
    this.#options = options;
  }

  public submit(): SourceDigestWorkSubmissionV1 {
    this.submissions += 1;
    const result =
      this.#options.completion ??
      ({ ok: true, value: this.#options.digest ?? DIGEST } as const);
    return {
      cancel: (): void => {
        this.cancelled += 1;
      },
      closeInput: (): void => {
        this.closed = true;
      },
      completion: Promise.resolve(result),
      update: (chunk): void => {
        this.updates += 1;
        this.#bytes += chunk.byteLength;
        this.#options.onBytes?.(this.#bytes);
        if (this.#options.updateError) throw new Error("update failed");
      },
    };
  }
}

class ThrowingDigestPort implements SourceDigestWorkPortV1 {
  readonly #stage: "submit" | "update";

  public constructor(stage: "submit" | "update" = "submit") {
    this.#stage = stage;
  }

  public submit(): SourceDigestWorkSubmissionV1 {
    if (this.#stage === "submit") throw new Error("submit failed");
    return {
      cancel: (): void => undefined,
      closeInput: (): void => undefined,
      completion: Promise.resolve({ ok: true, value: DIGEST }),
      update: async (): Promise<void> => {
        throw new Error("update failed");
      },
    };
  }
}
