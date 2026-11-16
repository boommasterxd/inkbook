import { expect, it } from "vitest";
import { capacityImageResource, validImageFixture } from "../../../fixtures/persistence/images";
import { rasterImage } from "../../../fixtures/persistence/image-svg";
import {
  encodeRuntimeSelection,
  resolveClipboardPayload,
} from "../../../../src/persistence/clipboard/codec";
import { encodeRuntimeSelectionChunked } from "../../../../src/persistence/worker/runtime/model/fallback-clipboard-codec";
import { validateClipboardPayload } from "../../../../src/persistence/clipboard/validation";
import { planPaste } from "../../../../src/persistence/clipboard/operations";
import { capturePastePlan } from "../../../../src/persistence/clipboard/paste-plan-snapshot";
import { page, RECTANGLE_ID, selectedElements } from "./fixtures";

it("copies only selected resources and preserves canonical image bytes through sliced paste", async () => {
  const asset = await capacityImageResource(0, 4000);
  const element = rasterImage(asset);
  const unused = { ...asset, id: "b".repeat(64) };
  const encoded = encodeRuntimeSelection([element], new Set([element.id]), [], [asset, unused]);
  if (!encoded.ok) throw new Error(encoded.error.message);
  expect(encoded.value.payload).toMatchObject({ version: 5, imageResources: [asset] });
  const sliced = await encodeRuntimeSelectionChunked(
    [element],
    [element.id],
    {
      checkpoint: () => undefined,
      signal: new AbortController().signal,
    },
    [],
    [asset],
  );
  expect(sliced).toMatchObject({ ok: true, value: { customText: encoded.value.customText } });
  const decoded = resolveClipboardPayload({ customText: encoded.value.customText });
  if (!decoded.ok) throw new Error(decoded.error.message);
  const plan = planPaste({
    decoded: decoded.value,
    existingElements: [],
    page: page(),
    target: { x: 300, y: 300 },
    commandTimestamp: 1,
    createId: () => RECTANGLE_ID,
  });
  if (!plan.ok) throw new Error(plan.error.message);
  expect(plan.value.imageIds).toEqual([RECTANGLE_ID]);
  expect(capturePastePlan(plan.value)?.imageResources).toEqual([asset]);
  expect(plan.value.elements[0]).toMatchObject({
    kind: "image",
    assetId: asset.id,
    crop: element.crop,
  });
});

it.each([false, true])(
  "plans only referenced rasters from a validated clipboard with images=%s",
  async (includeImage) => {
    const { asset, element } = await validImageFixture();
    const unused = await capacityImageResource(9);
    const elements = [...(includeImage ? [element] : []), selectedElements()[0]!];
    const encoded = encodeRuntimeSelection(
      elements,
      new Set(elements.map(({ id }) => id)),
      [],
      [asset],
    );
    if (!encoded.ok) throw new Error(encoded.error.message);
    const payload = {
      ...encoded.value.payload,
      version: 5,
      imageResources: [unused, ...(includeImage ? [asset] : [])],
    };
    const decoded = resolveClipboardPayload({ customText: JSON.stringify(payload) });
    if (!decoded.ok) throw new Error(decoded.error.message);
    expect(decoded.value.payload.imageResources).toHaveLength(includeImage ? 2 : 1);
    let next = 0;
    const planned = planPaste({
      decoded: decoded.value,
      existingElements: [],
      page: page(),
      target: { x: 300, y: 300 },
      commandTimestamp: 1,
      createId: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++next).padStart(12, "0")}`,
    });
    if (!planned.ok) throw new Error(planned.error.message);
    expect(planned.value.elements).toHaveLength(elements.length);
    expect(planned.value.imageResources).toEqual(includeImage ? [asset] : undefined);
  },
);

it("rejects forged, missing and out-of-source image resources before paste adoption", async () => {
  const { asset, element } = await validImageFixture();
  const encoded = encodeRuntimeSelection([element], new Set([element.id]), [], [asset]);
  if (!encoded.ok) throw new Error(encoded.error.message);
  const payload = encoded.value.payload;
  expect(validateClipboardPayload({ ...payload, imageResources: [] }).ok).toBe(false);
  expect(validateClipboardPayload({ ...payload, version: 2 }).ok).toBe(false);
  expect(
    validateClipboardPayload({ ...payload, imageResources: [{ ...asset, data: "AAAA" }] }).ok,
  ).toBe(false);
  expect(
    validateClipboardPayload({
      ...payload,
      elements: [
        {
          clipId: "0",
          element: { ...payload.elements[0]!.element, crop: { x: 1, y: 0, width: 1, height: 1 } },
        },
      ],
    }).ok,
  ).toBe(false);
});
