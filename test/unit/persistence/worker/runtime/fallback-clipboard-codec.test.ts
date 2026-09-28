import { describe, expect, it } from "vitest";

import { stroke } from "../../../domain/schema/fixtures";
import { encodeRuntimeSelection } from "../../../../../src/persistence/clipboard/codec";
import { encodeRuntimeSelectionChunked } from "../../../../../src/persistence/worker/runtime/fallback-clipboard-codec";
import {
  getValidatedClipboardBounds,
  validateClipboardPayloadSliced,
} from "../../../../../src/persistence/clipboard/validation";

describe("sliced clipboard fallback", () => {
  it("checks a long stroke during postparse validation and abandons cancelled bounds", async () => {
    const { createdAt: _createdAt, id: _id, ...body } = stroke();
    const payload = {
      format: "inkbook-elements",
      version: 1,
      elements: [
        {
          clipId: "0",
          element: {
            ...body,
            points: Array.from({ length: 12_000 }, (_, index) =>
              index % 3 === 2 ? 0.5 : Math.floor(index / 3),
            ),
          },
        },
      ],
    };
    const controller = new AbortController();
    let checkpoints = 0;
    await expect(
      validateClipboardPayloadSliced(
        payload,
        async () => {
          checkpoints += 1;
          if (checkpoints === 4) controller.abort();
          controller.signal.throwIfAborted();
        },
        64,
        170,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(checkpoints).toBe(4);
    expect(getValidatedClipboardBounds(payload as never)).toBeNull();

    checkpoints = 0;
    const validated = await validateClipboardPayloadSliced(
      payload,
      async () => {
        checkpoints += 1;
      },
      64,
      170,
    );
    expect(validated.ok).toBe(true);
    expect(checkpoints).toBeGreaterThan(20);
    if (validated.ok) expect(getValidatedClipboardBounds(validated.value)).toHaveLength(1);
  });

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
