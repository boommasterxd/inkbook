import { expect, it, vi } from "vitest";
import { FontImportStaging } from "../../../../src/obsidian/fonts/font-import-staging";
import { ChunkedSha256 } from "../../../../src/persistence/serialization/chunked-output-sha256";
import { FONT_LIMITS } from "../../../../src/persistence/fonts/font-container";
import { readBundledFont } from "../../../fixtures/persistence/font-assets";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";

const options = {
  descriptor: { family: "upload", weight: 400, style: "normal" },
  fallbackName: "regular.woff2",
  useMetadata: true,
} as const;

it("hashes each owned binary once and releases the prepared resource without vault work", async () => {
  const bytes = await readBundledFont("inter-400-normal.woff2");
  const staging = new FontImportStaging();
  const sanitize = vi.fn(async () => undefined);
  const hash = vi.spyOn(ChunkedSha256.prototype, "update");
  try {
    const prepared = await staging.prepare(bytes, options, new TestWorkScheduler(), sanitize);
    expect(hash).toHaveBeenCalledTimes(Math.ceil(bytes.length / 4096));
    expect(sanitize).toHaveBeenCalledOnce();
    const owned = staging.bytes(prepared);
    expect(owned).not.toBe(bytes);
    expect(owned).toEqual(bytes);
    staging.bytes(prepared);
    expect(hash).toHaveBeenCalledTimes(Math.ceil(bytes.length / 4096));
    expect(sanitize).toHaveBeenCalledOnce();
    staging.release(prepared);
    expect(() => staging.bytes(prepared)).toThrow("no longer available");
    staging.dispose();
  } finally {
    hash.mockRestore();
  }
});

it("bounds in-flight binary plus base64 ownership before validating a second maximum-size source", async () => {
  const staging = new FontImportStaging();
  const scheduler = new TestWorkScheduler();
  const sanitize = vi.fn(async () => undefined);
  const maximum = new Uint8Array(FONT_LIMITS.fileBytes);
  const first = staging.prepare(maximum, options, scheduler, sanitize);
  const second = staging.prepare(maximum, options, scheduler, sanitize);
  const results = await Promise.allSettled([first, second]);
  expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "invalid-font" } });
  expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "staging-limit" } });
  expect(sanitize).not.toHaveBeenCalled();
  const recovered = await staging.prepare(
    await readBundledFont("inter-400-normal.woff2"),
    options,
    scheduler,
    sanitize,
  );
  expect(sanitize).toHaveBeenCalledOnce();
  expect(staging.bytes(recovered).length).toBeGreaterThan(0);
  staging.dispose();
  expect(() => staging.bytes(recovered)).toThrow("disposed");
});
