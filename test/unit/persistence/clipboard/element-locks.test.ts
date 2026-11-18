import { expect, it } from "vitest";
import {
  encodeRuntimeSelection,
  resolveClipboardPayload,
} from "../../../../src/persistence/clipboard/codec";
import { planPaste } from "../../../../src/persistence/clipboard/operations";
import { validateClipboardPayload } from "../../../../src/persistence/clipboard/validation";
import { encodeRuntimeSelectionChunked } from "../../../../src/persistence/worker/runtime/model/fallback-clipboard-codec";
import { rasterResource } from "../../../fixtures/persistence/image-svg";
import { imageElement } from "../../../fixtures/domain/images";
import { rectangle, stroke, textElement, uuid } from "../../domain/schema/fixtures";
import { page, validFontResource } from "./fixtures";

it("preserves mixed locks, shared resources and worker parity when copying and pasting", async () => {
  const asset = rasterResource();
  const font = await validFontResource();
  const text = textElement();
  text.style.fontFamily = font.family;
  const elements = [
    {
      ...imageElement(),
      assetId: asset.id,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      locked: true,
    },
    { ...stroke(), locked: true },
    rectangle(),
    { ...text, locked: true },
  ];
  const selected = new Set(elements.map(({ id }) => id));
  const encoded = encodeRuntimeSelection(elements, selected, [font], [asset]);
  if (!encoded.ok) throw new Error(encoded.error.message);
  expect(encoded.value.payload.version).toBe(5);
  const context = { checkpoint: () => undefined, signal: new AbortController().signal };
  const worker = await encodeRuntimeSelectionChunked(elements, context, [font], [asset]);
  if (!worker.ok) throw new Error(worker.error.message);
  expect(worker.value.customText).toBe(encoded.value.customText);
  expect(validateClipboardPayload({ ...encoded.value.payload, version: 3 }).ok).toBe(false);
  const decoded = resolveClipboardPayload({ customText: encoded.value.customText });
  if (!decoded.ok) throw new Error(decoded.error.message);
  let id = 9000;
  const pasted = planPaste({
    decoded: decoded.value,
    existingElements: [],
    page: page(),
    target: { x: 500, y: 500 },
    commandTimestamp: 1,
    createId: () => uuid(id++),
  });
  if (!pasted.ok) throw new Error(pasted.error.message);
  expect(pasted.value.elements.map(({ locked }) => locked === true)).toEqual([
    true,
    true,
    false,
    true,
  ]);
  expect(pasted.value.elements.every((element) => !selected.has(element.id))).toBe(true);
  expect(pasted.value.imageResources).toEqual([asset]);
});

it("omits an unlocked header so older clipboard readers can still open the copy", async () => {
  const element = { ...rectangle(), locked: false };
  const encoded = encodeRuntimeSelection([element], new Set([element.id]));
  if (!encoded.ok) throw new Error(encoded.error.message);
  expect(encoded.value.payload.version).toBe(1);
  expect(
    Object.prototype.hasOwnProperty.call(encoded.value.payload.elements[0]!.element, "locked"),
  ).toBe(false);
  const worker = await encodeRuntimeSelectionChunked([element], {
    checkpoint: () => undefined,
    signal: new AbortController().signal,
  });
  if (!worker.ok) throw new Error(worker.error.message);
  expect(worker.value.customText).toBe(encoded.value.customText);
});
