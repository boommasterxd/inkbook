import { describe, expect, it, vi } from "vitest";

import { stroke } from "../../../../domain/schema/fixtures";
import { encodeRuntimeSelection } from "../../../../../../src/persistence/clipboard/codec";
import { encodeRuntimeSelectionChunked } from "../../../../../../src/persistence/worker/runtime/model/fallback-clipboard-codec";
import {
  getValidatedClipboardBounds,
  validateClipboardPayloadSliced,
} from "../../../../../../src/persistence/clipboard/validation";
import { decodeClipboardChunked } from "../../../../../../src/persistence/worker/runtime/model/fallback-clipboard-codec";
import { validFontResource, textElement } from "../../../clipboard/fixtures";

it("retains the bound base face for formula-only clipboard layouts", async () => {
  const element = textElement("$x$");
  element.layout = {
    version: 1,
    lines: [],
    math: [
      {
        start: 0,
        end: 3,
        display: false,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        paths: [{ d: "M0 0L10 10" }],
      },
    ],
  };
  const font = await validFontResource();
  const context = { checkpoint: () => undefined, signal: new AbortController().signal };
  const expected = encodeRuntimeSelection([element], new Set([element.id]), [font]);
  if (!expected.ok) throw new Error(expected.error.message);
  const encoded = await encodeRuntimeSelectionChunked([element], [element.id], context, [font]);
  if (!encoded.ok) throw new Error(encoded.error.message);
  expect(encoded.value.customText).toBe(expected.value.customText);
  expect(element.layout.baseFontResourceId).toBeUndefined();
  const decoded = await decodeClipboardChunked({ customText: encoded.value.customText }, context);
  if (!decoded.ok) throw new Error(decoded.error.message);
  expect(decoded.value.payload.version).toBe(2);
  expect(decoded.value.payload.fontResources?.map(({ id }) => id)).toEqual([font.id]);
  expect(encoded.value.customText.split(font.data)).toHaveLength(2);
  expect(decoded.value.payload.elements[0]!.element).toMatchObject({
    kind: "text",
    source: "$x$",
    layout: { ...element.layout, baseFontResourceId: font.id },
  });
});

it("slices large font and escaped text strings without changing canonical bytes", async () => {
  const element = textElement('"\\\n😀'.repeat(2_000));
  const font = await validFontResource();
  const selected = new Set([element.id]);
  const expected = encodeRuntimeSelection([element], selected, [font]);
  if (!expected.ok) throw new Error(expected.error.message);
  let checkpoints = 0;
  const context = {
    checkpoint: () => {
      checkpoints += 1;
      return undefined;
    },
    signal: new AbortController().signal,
    workProfile: { inputByteLimit: 4096, nodeLimit: 64, outputByteLimit: 16384 },
  };
  const stringify = JSON.stringify;
  let maximumString = 0;
  const spy = vi.spyOn(JSON, "stringify").mockImplementation((value: unknown) => {
    if (typeof value === "string") maximumString = Math.max(maximumString, value.length);
    return stringify(value);
  });
  let encoded;
  try {
    encoded = await encodeRuntimeSelectionChunked([element], [element.id], context, [font]);
  } finally {
    spy.mockRestore();
  }
  expect(encoded).toMatchObject({ ok: true, value: { customText: expected.value.customText } });
  expect(maximumString).toBeLessThanOrEqual(context.workProfile.inputByteLimit);
  expect(checkpoints).toBeGreaterThan(
    Math.floor(font.data.length / context.workProfile.inputByteLimit),
  );
  const decoded = await decodeClipboardChunked({ customText: expected.value.customText }, context);
  expect(decoded).toMatchObject({ ok: true, value: { payload: expected.value.payload } });
});
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
