import { describe, expect, it } from "vitest";

import {
  SOURCE_COORDINATION_LIMITS_V1,
  createSourceSnapshot,
  digestMarkdownSnapshot,
  preflightSourceSnapshot,
} from "../../../src/application/source-coordination/limits";
import {
  ImmediateSourceDigestWorkPort,
  TestStreamingDigestPort,
  digestUtf8,
} from "./support";

/* eslint-disable @typescript-eslint/no-magic-numbers -- Boundary fixtures directly exercise the exact source limits. */

describe("source snapshot preflight", () => {
  it("accepts the UTF-16 limit and rejects one code unit above it", () => {
    const block = `${"a".repeat(
      SOURCE_COORDINATION_LIMITS_V1.maxSourceBlockUtf16Length - 2,
    )}\n\n`;
    const atLimit = block.repeat(8);
    expect(atLimit).toHaveLength(
      SOURCE_COORDINATION_LIMITS_V1.maxMarkdownUtf16Length,
    );
    expect(preflightSourceSnapshot(atLimit).ok).toBe(true);
    expect(preflightSourceSnapshot(`${atLimit}a`)).toEqual({
      ok: false,
      code: "resource-limit",
    });
  });

  it("accepts the UTF-8 byte limit and rejects one byte above it", () => {
    const fullBlock = `${"€".repeat(999_998)}\n\n`;
    const atLimit = `${fullBlock.repeat(5)}${"€".repeat(592_412)}`;
    expect(new TextEncoder().encode(atLimit)).toHaveLength(
      SOURCE_COORDINATION_LIMITS_V1.maxMarkdownUtf8Bytes,
    );
    expect(preflightSourceSnapshot(atLimit).ok).toBe(true);
    expect(preflightSourceSnapshot(`${atLimit}a`)).toEqual({
      ok: false,
      code: "resource-limit",
    });
  });

  it("checks one source block below, at, and above its limit", () => {
    const limit = SOURCE_COORDINATION_LIMITS_V1.maxSourceBlockUtf16Length;
    expect(preflightSourceSnapshot("a".repeat(limit - 1)).ok).toBe(true);
    expect(preflightSourceSnapshot("a".repeat(limit)).ok).toBe(true);
    expect(preflightSourceSnapshot("a".repeat(limit + 1))).toEqual({
      ok: false,
      code: "resource-limit",
    });
  });

  it("checks source-block count at and above its limit", () => {
    const atLimit = `${"a\n\n".repeat(
      SOURCE_COORDINATION_LIMITS_V1.maxSourceBlocks - 1,
    )}a`;
    expect(preflightSourceSnapshot(atLimit).ok).toBe(true);
    expect(preflightSourceSnapshot(`${atLimit}\n\na`)).toEqual({
      ok: false,
      code: "resource-limit",
    });
  });
});

describe("source digest worker admission", () => {
  it.each([
    [SOURCE_COORDINATION_LIMITS_V1.sourceDigestWorkerAdmissionBytes - 1, 0],
    [SOURCE_COORDINATION_LIMITS_V1.sourceDigestWorkerAdmissionBytes, 1],
    [SOURCE_COORDINATION_LIMITS_V1.sourceDigestWorkerAdmissionBytes + 1, 1],
  ])(
    "routes %i UTF-8 bytes to %i worker submissions",
    async (length, count) => {
      const markdown = "a".repeat(length);
      const snapshot = createSourceSnapshot(markdown);
      expect(snapshot.ok).toBe(true);
      if (!snapshot.ok) return;
      const work = new ImmediateSourceDigestWorkPort();
      await expect(
        digestMarkdownSnapshot(
          new TestStreamingDigestPort(),
          snapshot.value,
          work,
        ),
      ).resolves.toEqual({ ok: true, value: digestUtf8(markdown) });
      expect(work.submissions).toBe(count);
      expect(
        work.chunkSizes.every(
          (chunk) =>
            chunk <= SOURCE_COORDINATION_LIMITS_V1.maxStreamingDigestChunkBytes,
        ),
      ).toBe(true);
    },
  );

  it("cancels an already-aborted worker digest without packing input", async () => {
    const markdown = "a".repeat(
      SOURCE_COORDINATION_LIMITS_V1.sourceDigestWorkerAdmissionBytes,
    );
    const snapshot = createSourceSnapshot(markdown);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const controller = new AbortController();
    controller.abort();
    const work = new ImmediateSourceDigestWorkPort();
    await expect(
      digestMarkdownSnapshot(
        new TestStreamingDigestPort(),
        snapshot.value,
        work,
        controller.signal,
      ),
    ).resolves.toEqual({ ok: false, code: "disposed" });
    expect(work.chunkSizes).toHaveLength(0);
  });
});
