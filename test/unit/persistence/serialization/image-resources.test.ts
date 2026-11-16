import { expect, it } from "vitest";
import { rasterResource } from "../../../fixtures/persistence/image-svg";
import {
  createImageResource,
  decodeImageResourceSteps,
  validateImageResource,
} from "../../../../src/persistence/images/image-resources";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { imageHeaderBytes, progressiveJpegBytes } from "../../../fixtures/persistence/images";
import { webpBytes } from "../../../fixtures/persistence/webp-images";

it("rejects forged raster identities, dimensions, MIME types and noncanonical payloads", async () => {
  const resource = rasterResource();
  const scheduler = new TestWorkScheduler();
  await expect(validateImageResource(resource, scheduler)).resolves.toBeUndefined();
  for (const forged of [
    { ...resource, id: "0".repeat(64) },
    { ...resource, width: 2 },
    { ...resource, mimeType: "image/jpeg" as const },
    { ...resource, data: resource.data + "=" },
    { ...resource, data: resource.data.replace("V", " ") },
    { ...resource, data: resource.data.replace("V", "_") },
  ])
    await expect(validateImageResource(forged, scheduler)).rejects.toThrow();
});

it("decodes identical canonical bytes with the native and legacy image paths", () => {
  const resource = rasterResource();
  const descriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "setFromBase64");
  const decode = () => {
    const steps = decodeImageResourceSteps(resource);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  };
  const expected = Uint8Array.from(atob(resource.data), (character) => character.charCodeAt(0));
  try {
    expect(decode()).toEqual(expected);
    Object.defineProperty(Uint8Array.prototype, "setFromBase64", {
      configurable: true,
      value: undefined,
    });
    expect(decode()).toEqual(expected);
  } finally {
    if (descriptor !== undefined)
      Object.defineProperty(Uint8Array.prototype, "setFromBase64", descriptor);
    else Reflect.deleteProperty(Uint8Array.prototype, "setFromBase64");
  }
});

it("rejects a JPEG with a truncated quantization segment as an unsupported format", async () => {
  const truncated = progressiveJpegBytes().slice(0, 24);
  await expect(
    createImageResource(truncated, "image/jpeg", new TestWorkScheduler()),
  ).rejects.toMatchObject({ reason: "format" });
});

it.each([
  {
    name: "progressive JPEG",
    mimeType: "image/jpeg" as const,
    bytes: progressiveJpegBytes,
    width: 16,
    height: 16,
  },
  ...(["lossy", "lossless", "alpha"] as const).map((kind) => ({
    name: `${kind} WebP`,
    mimeType: "image/webp" as const,
    bytes: () => webpBytes(kind),
    width: 3,
    height: 2,
  })),
])(
  "roundtrips a real $name resource and independently rejects forged identity and dimensions",
  async ({ bytes: createBytes, mimeType, width, height }) => {
    const bytes = createBytes();
    const scheduler = new TestWorkScheduler();
    const resource = await createImageResource(bytes, mimeType, scheduler);
    expect(resource).toMatchObject({ mimeType, width, height });
    expect(resource).not.toHaveProperty("lossless");
    expect(Uint8Array.from(atob(resource.data), (character) => character.charCodeAt(0))).toEqual(
      bytes,
    );
    await expect(validateImageResource({ ...resource }, scheduler)).resolves.toBeUndefined();
    for (const forged of [
      { ...resource, id: "0".repeat(64) },
      { ...resource, width: width + 1 },
      { ...resource, mimeType: "image/png" as const },
    ])
      await expect(validateImageResource(forged, scheduler)).rejects.toThrow();
    await expect(createImageResource(bytes, "image/png", scheduler)).rejects.toThrow(
      "MIME type does not match content",
    );
  },
);

it("admits only lossless WebP when encoding requires pixel fidelity", async () => {
  const scheduler = new TestWorkScheduler();
  for (const kind of ["lossy", "alpha"] as const)
    await expect(
      createImageResource(webpBytes(kind), "image/webp", scheduler, undefined, {
        requireLosslessWebp: true,
      }),
    ).rejects.toThrow("A lossless WebP resource is required.");
  await expect(
    createImageResource(webpBytes(), "image/webp", scheduler, undefined, {
      requireLosslessWebp: true,
    }),
  ).resolves.toMatchObject({ mimeType: "image/webp", width: 3, height: 2 });
});

it("keeps persisted raster resources limited to 16MP despite larger source admission", async () => {
  const resource = rasterResource();
  const bytes = Uint8Array.from(atob(resource.data), (character) => character.charCodeAt(0));
  await expect(
    createImageResource(imageHeaderBytes(bytes, 4001, 4000), "image/png", new TestWorkScheduler()),
  ).rejects.toMatchObject({ reason: "dimensions" });
});
