import { describe, expect, it } from "vitest";
import { validateInkElementV1, validateInkSnapshotV1 } from "../../../../src/domain/schema/public";
import { assertImageResourcesSteps } from "../../../../src/domain/schema/image-validation";
import { IMAGE_LIMITS } from "../../../../src/domain/images/image-limits";
import {
  imageElement,
  imageResource,
  maximumPixelResources,
} from "../../../fixtures/domain/images";
import { snapshot, straightHighlighter, textElement, uuid } from "./fixtures";
import { webpBytes } from "../../../fixtures/persistence/webp-images";

function document() {
  return { ...snapshot([imageElement()]), version: 3 as const, imageResources: [imageResource()] };
}

describe("native image validation", () => {
  it("allows bounded WebP resources in version 3 while rejecting a legacy version", () => {
    const resource = {
      ...imageResource(),
      mimeType: "image/webp",
      width: 3,
      height: 2,
      data: btoa(String.fromCharCode(...webpBytes())),
    };
    const element = { ...imageElement(), crop: { x: 0, y: 0, width: 3, height: 2 } };
    const value = { ...document(), elements: [element], imageResources: [resource] };
    expect(validateInkSnapshotV1(value).ok).toBe(true);
    expect(validateInkSnapshotV1({ ...value, version: 2 }).ok).toBe(false);
  });
  it("keeps source data outside image elements and requires version 3 with a matching resource", () => {
    expect(validateInkElementV1(imageElement()).ok).toBe(true);
    expect(validateInkElementV1({ ...imageElement(), data: "AA==" }).ok).toBe(false);
    expect(validateInkSnapshotV1(document()).ok).toBe(true);
    expect(validateInkSnapshotV1({ ...document(), version: 2 }).ok).toBe(false);
    expect(validateInkSnapshotV1({ ...document(), imageResources: [] }).ok).toBe(false);
    const resource = { ...imageResource(), id: "b".repeat(64) };
    expect(validateInkSnapshotV1({ ...document(), imageResources: [resource] }).ok).toBe(false);
  });

  it("requires positive crop/box dimensions and rejects out-of-source crops and noncanonical geometry", () => {
    for (const crop of [
      { x: -1 },
      { width: 0 },
      { height: 0 },
      { x: 0.0001 },
      { x: 1 },
      { height: 201 },
    ]) {
      const image = { ...imageElement(), crop: { ...imageElement().crop, ...crop } };
      expect(validateInkSnapshotV1({ ...document(), elements: [image] }).ok).toBe(false);
    }
    for (const invalid of [{ width: 0 }, { height: -1 }, { assetId: "A".repeat(64) }])
      expect(validateInkElementV1({ ...imageElement(), ...invalid }).ok).toBe(false);
  });

  it("places images below highlights and content while allowing v2 text and fonts in v3", () => {
    const elements = [imageElement(), straightHighlighter(), textElement()];
    expect(validateInkSnapshotV1({ ...document(), elements, fontResources: [] }).ok).toBe(true);
    expect(validateInkSnapshotV1({ ...document(), elements: [...elements].reverse() }).ok).toBe(
      false,
    );
    expect(
      validateInkSnapshotV1({ ...document(), elements: [elements[0], elements[2], elements[1]] })
        .ok,
    ).toBe(false);
  });

  it("rejects malformed resource identity, MIME, capacities, duplicate IDs and Base64 padding bits", () => {
    for (const invalid of [
      { mimeType: "image/svg+xml" },
      { id: "A".repeat(64) },
      { width: 0 },
      { width: IMAGE_LIMITS.resourceAxis + 1 },
      { width: 2001, height: 2000 },
      { data: "AB==" },
      { data: "AAF=" },
      { data: "AA=A" },
      { data: "" },
      { data: "AA" },
      { data: "AA==\n" },
    ]) {
      const resource = { ...imageResource(), ...invalid };
      expect(validateInkSnapshotV1({ ...document(), imageResources: [resource] }).ok).toBe(false);
    }
    expect(
      validateInkSnapshotV1({ ...document(), imageResources: [imageResource(), imageResource()] })
        .ok,
    ).toBe(false);
  });

  it("validates encoded data in bounded cooperative chunks and rejects decoded byte overflow", () => {
    const data = "AAAA".repeat(40_000);
    const steps = assertImageResourcesSteps([{ ...imageResource(), data }], "$.imageResources");
    let yields = 0;
    while (!steps.next().done) yields += 1;
    expect(yields).toBe(Math.ceil(data.length / 65_536) + 1);
    const oversized = "AAAA".repeat(Math.ceil((IMAGE_LIMITS.resourceBytes + 1) / 3));
    expect(() =>
      assertImageResourcesSteps([{ ...imageResource(), data: oversized }], "$.").next(),
    ).toThrow();
    expect(() =>
      assertImageResourcesSteps(
        Array.from({ length: IMAGE_LIMITS.resources + 1 }, imageResource),
        "$.",
      ).next(),
    ).toThrow();
  });
});

it("limits the retained unique resource set to 32 megapixels while allowing repeated element references", () => {
  const resources = maximumPixelResources();
  const elements = Array.from({ length: 9 }, (_, index) => ({
    ...imageElement(),
    id: uuid(index + 100),
    assetId: resources[0]!.id,
  }));
  const atCapacity = { ...document(), elements, imageResources: resources };
  expect(validateInkSnapshotV1(atCapacity).ok).toBe(true);
  const oneMorePixel = { ...imageResource(), id: "b".repeat(64), width: 1, height: 1 };
  expect(
    validateInkSnapshotV1({ ...atCapacity, imageResources: [...resources, oneMorePixel] }),
  ).toMatchObject({
    ok: false,
    error: {
      code: "invalid-range",
      path: "$.imageResources",
      message: "Document image pixel capacity exceeded.",
    },
  });
  expect(
    validateInkSnapshotV1({ ...atCapacity, imageResources: [...resources, resources[0]] }),
  ).toMatchObject({
    ok: false,
    error: { code: "duplicate-id" },
  });
});
