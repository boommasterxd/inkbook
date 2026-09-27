import { describe, expect, it } from "vitest";

import { stroke } from "../../../domain/schema/fixtures";
import { encodeRuntimeSelection } from "../../../../../src/persistence/clipboard/codec";
import { encodeRuntimeSelectionChunked } from "../../../../../src/persistence/worker/runtime/fallback-clipboard-codec";

describe("sliced clipboard fallback", () => {
  it("preserves canonical bytes with bounded checkpoints across a large selection", async () => {
    const elements = Array.from({ length: 257 }, (_, index) => stroke(index + 1));
    const selectedIds = elements.map(({ id }) => id);
    const expected = encodeRuntimeSelection(elements, new Set(selectedIds));
    expect(expected.ok).toBe(true);
    let checkpoints = 0;

    const result = await encodeRuntimeSelectionChunked(elements, selectedIds, {
      checkpoint: async () => {
        checkpoints += 1;
      },
      signal: new AbortController().signal,
      workProfile: { inputByteLimit: 4096, nodeLimit: 64, outputByteLimit: 16384 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !expected.ok) throw new Error("Expected encoded clipboard data.");
    expect(result.value.customText).toBe(expected.value.customText);
    expect(result.value.plainText).toBe(expected.value.plainText);
    expect(result.value.byteLength).toBe(new TextEncoder().encode(result.value.customText).length);
    expect(checkpoints).toBeGreaterThan(90);
    expect(checkpoints).toBeLessThan(120);
  });

  it("stops at a checkpoint when the request is aborted", async () => {
    const elements = Array.from({ length: 257 }, (_, index) => stroke(index + 1));
    const controller = new AbortController();
    let checkpoints = 0;

    await expect(
      encodeRuntimeSelectionChunked(
        elements,
        elements.map(({ id }) => id),
        {
          checkpoint: async () => {
            checkpoints += 1;
            if (checkpoints === 3) controller.abort();
            controller.signal.throwIfAborted();
          },
          signal: controller.signal,
          workProfile: { inputByteLimit: 4096, nodeLimit: 64, outputByteLimit: 16384 },
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(checkpoints).toBe(3);
  });
});
