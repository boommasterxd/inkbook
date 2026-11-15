import { afterEach, expect, it, vi } from "vitest";
import { assertImageResourcesSteps } from "../../../src/domain/schema/image-validation";
import { IMAGE_LIMITS } from "../../../src/domain/images/image-limits";
import { imageResource, maximumPixelResources } from "../../fixtures/domain/images";

afterEach(() => vi.restoreAllMocks());

it("scans each Base64 byte once in bounded scheduler-admitted chunks at resource capacity", () => {
  const data = "AAAA".repeat(Math.floor(IMAGE_LIMITS.resourceBytes / 3));
  const test = Object.getOwnPropertyDescriptor(RegExp.prototype, "test")!.value as (
    this: RegExp,
    input: string,
  ) => boolean;
  let scanned = 0;
  let inStep = 0;
  vi.spyOn(RegExp.prototype, "test").mockImplementation(function (this: RegExp, input: string) {
    if (input.length > 64) {
      expect(input.length).toBeLessThanOrEqual(65_536);
      scanned += input.length;
      inStep += input.length;
    }
    return test.call(this, input);
  });
  const steps = assertImageResourcesSteps([{ ...imageResource(), data }], "$.imageResources");
  for (let count = 0; count <= Math.ceil(data.length / 65_536) + 2; count += 1) {
    inStep = 0;
    const step = steps.next();
    expect(inStep).toBeLessThanOrEqual(65_536);
    if (step.done) {
      expect(scanned).toBe(data.length);
      return;
    }
  }
  throw new Error("Image resource validation did not finish within its bounded chunk count.");
});

it("rejects decoded pixel overflow before reading or scanning the excluded resource data", () => {
  const resources = maximumPixelResources();
  const data = vi.fn(() => "AA==");
  const excluded = { ...imageResource(), id: "b".repeat(64), width: 1, height: 1 };
  Object.defineProperty(excluded, "data", { get: data, enumerable: true });
  const steps = assertImageResourcesSteps([...resources, excluded], "$.imageResources");
  expect(() => {
    for (let count = 0; count < 20; count += 1) steps.next();
  }).toThrow("Document image pixel capacity exceeded.");
  expect(data).not.toHaveBeenCalled();
});

it("accepts the complete asset capacity and rejects aggregate byte overflow", () => {
  const assets = Array.from({ length: IMAGE_LIMITS.resources }, (_, index) => ({
    ...imageResource(),
    id: index.toString(16).padStart(64, "0"),
  }));
  const steps = assertImageResourcesSteps(assets, "$.imageResources");
  let complete = false;
  for (let count = 0; count <= IMAGE_LIMITS.resources * 2; count += 1) {
    if (steps.next().done) {
      complete = true;
      break;
    }
  }
  expect(complete).toBe(true);
  const data = "AAAA".repeat(Math.floor(IMAGE_LIMITS.resourceBytes / 3));
  const tooManyBytes = assets.slice(0, 4).map((resource) => ({ ...resource, data }));
  const invalid = assertImageResourcesSteps(tooManyBytes, "$.imageResources");
  expect(() => {
    for (let count = 0; count < 1_000; count += 1) {
      if (invalid.next().done) throw new Error("Aggregate image capacity was not enforced.");
    }
  }).toThrow("Document image byte capacity exceeded.");
});
