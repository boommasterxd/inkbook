// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { createPreviewSvgAsync } from "../../../../src/obsidian/embeds/safe-preview-builder";
import { createPreviewSvg } from "../../../../src/obsidian/embeds/safe-preview-svg";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { createSnapshot } from "../../persistence/serialization/fixtures";

afterEach(() => vi.restoreAllMocks());

it("preserves the canonical detached preview without stylesheet or metadata", async () => {
  const serialized = serializeInkbookDocument(createSnapshot());
  if (!serialized.ok) throw new Error("Fixture serialization failed.");
  const source = serialized.value.svg;
  const expected = createPreviewSvg(document, source);
  const parse = vi.spyOn(window.DOMParser.prototype, "parseFromString");
  const imported = vi.spyOn(document, "importNode");
  const actual = await createPreviewSvgAsync(document, source, {
    checkpoint: async () => {},
    isCancelled: () => false,
  });
  expect(actual?.outerHTML).toBe(expected.outerHTML);
  expect(actual?.isConnected).toBe(false);
  expect(actual?.querySelector("metadata, style")).toBeNull();
  expect(parse).not.toHaveBeenCalled();
  expect(imported).not.toHaveBeenCalled();
});

it("cancels before building any SVG when the initial idle wait is invalidated", async () => {
  const create = vi.spyOn(document, "createElementNS");
  expect(
    await createPreviewSvgAsync(document, "", {
      checkpoint: async () => {},
      isCancelled: () => true,
    }),
  ).toBeUndefined();
  expect(create).not.toHaveBeenCalled();
});

it("bounds element creation and cancels a partially built detached tree", async () => {
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg"><metadata></metadata>' +
    '<g opacity="0.5"><path d="M0 0L1 1"/></g>'.repeat(10_000) +
    "</svg>";
  const create = vi.spyOn(document, "createElementNS");
  let previous = 0;
  let checkpoints = 0;
  const result = await createPreviewSvgAsync(document, source, {
    checkpoint: async () => {
      expect(create.mock.calls.length - previous).toBeLessThanOrEqual(32);
      previous = create.mock.calls.length;
      checkpoints += 1;
    },
    isCancelled: () => checkpoints === 5,
  });
  expect(result).toBeUndefined();
  expect(create).toHaveBeenCalledTimes(128);
});

it("yields during long metadata scanning before constructing content", async () => {
  const source = "<svg><metadata>" + "x".repeat(128 * 1024) + '</metadata><path d="M0 0"/></svg>';
  const create = vi.spyOn(document, "createElementNS");
  let checkpoints = 0;
  expect(
    await createPreviewSvgAsync(document, source, {
      checkpoint: async () => {
        checkpoints += 1;
      },
      isCancelled: () => checkpoints === 4,
    }),
  ).toBeUndefined();
  expect(create).toHaveBeenCalledTimes(1);
});

it.each(["<svg><foreignObject/></svg>", '<svg><path d="M0 0"/>', "<g></g>"])(
  "rejects unexpected or truncated markup: %s",
  async (source) => {
    await expect(
      createPreviewSvgAsync(document, source, {
        checkpoint: async () => {},
        isCancelled: () => false,
      }),
    ).rejects.toThrow("validated Inkbook preview");
  },
);
