import { describe, expect, it, vi } from "vitest";
import { StreamingSafeStaticValidator } from "../../../../src/persistence/serialization/streaming-safe-static";
import {
  createMaximumComplexityPath,
  MAXIMUM_PATH_BYTES,
} from "../../../fixtures/persistence/safe-svg";

const PREFIX =
  '<g id="inkbook-background"></g><g id="inkbook-highlights"></g><g id="inkbook-content">';
const PATH = '<path d="M 0 0 L 1 1" fill="none"/>';
const SUFFIX = "</g></svg>";

async function validate(content: string, chunk = 23) {
  const validator = new StreamingSafeStaticValidator(async () => undefined);
  const input = PREFIX + content + SUFFIX;
  for (let start = 0; start < input.length; start += chunk) {
    if (!(await validator.write(input.slice(start, start + chunk)))) return false;
  }
  return validator.finish();
}

describe("streaming safe static presentation", () => {
  it.each([1, 23, 4096])(
    "accepts safe groups and whitespace across %s character chunks",
    async (chunk) => {
      expect(await validate(` \n${PATH}\t<g opacity="0.5">${PATH}</g>\r`, chunk)).toBe(true);
    },
  );

  it.each([
    '<g opacity="0.5"></g>',
    `<g opacity="0.5">${PATH}${PATH}</g>`,
    `<g opacity="0.5"><g opacity="0.5">${PATH}</g></g>`,
    '<path d="M NaN 0"/>',
    '<path d="M 0 0" onload="run()"/>',
    '<path d="M 0 0" fill="url(https://example.invalid)"/>',
    '<path d="M 0 0" fill="#000000FF" fill="#FFFFFFFF"/>',
    '<image href="x"/>',
    "<script/>",
    "<!--comment-->",
    "<?xml a?>",
    "text",
  ])("rejects unsafe or malformed content %s", async (content) => {
    expect(await validate(content)).toBe(false);
  });

  it.each([PREFIX, PREFIX + PATH, PREFIX + PATH + "</g>", PREFIX + SUFFIX + PATH])(
    "rejects incomplete or trailing presentation",
    async (input) => {
      const validator = new StreamingSafeStaticValidator(async () => undefined);
      const written = await validator.write(input);
      expect(written && validator.finish()).toBe(false);
    },
  );

  it("validates a maximum legal path incrementally and cancels from its checkpoint", async () => {
    const content = `<path d="${createMaximumComplexityPath()}"/>`;
    const checkpoint = vi.fn(async () => undefined);
    const validator = new StreamingSafeStaticValidator(checkpoint);
    expect(await validator.write(PREFIX + content + SUFFIX)).toBe(true);
    expect(validator.finish()).toBe(true);
    expect(validator.maximumRetainedCharacters).toBeLessThanOrEqual(MAXIMUM_PATH_BYTES + 4096);
    expect(checkpoint).toHaveBeenCalled();
    const cancelled = new StreamingSafeStaticValidator(async () => {
      throw new Error("cancelled");
    });
    await expect(cancelled.write(PREFIX + content + SUFFIX)).rejects.toThrow("cancelled");
    expect(cancelled.finish()).toBe(false);
  });

  it("rejects over-capacity unfinished tags and does not resume after rejection", async () => {
    const validator = new StreamingSafeStaticValidator(async () => undefined);
    expect(
      await validator.write(PREFIX + '<path d="' + " ".repeat(MAXIMUM_PATH_BYTES + 4096)),
    ).toBe(false);
    expect(await validator.write('"/>' + SUFFIX)).toBe(false);
    expect(validator.finish()).toBe(false);
  });
});
