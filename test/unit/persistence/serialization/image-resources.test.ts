import { expect, it } from "vitest";
import { rasterResource } from "../../../fixtures/persistence/image-svg";
import {
  decodeImageResourceSteps,
  validateImageResourceSteps,
} from "../../../../src/persistence/images/image-resources";
import { exhaustValidation } from "../../../fixtures/persistence/safe-svg";

it("rejects forged raster identities, dimensions, MIME types and noncanonical payloads", () => {
  const resource = rasterResource();
  expect(exhaustValidation(validateImageResourceSteps(resource)).result).toBeUndefined();
  for (const forged of [
    { ...resource, id: "0".repeat(64) },
    { ...resource, width: 2 },
    { ...resource, mimeType: "image/jpeg" as const },
    { ...resource, data: resource.data + "=" },
    { ...resource, data: resource.data.replace("V", " ") },
    { ...resource, data: resource.data.replace("V", "_") },
  ])
    expect(() => exhaustValidation(validateImageResourceSteps(forged))).toThrow();
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
