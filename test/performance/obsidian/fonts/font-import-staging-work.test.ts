import { expect, it, vi } from "vitest";
import { FontImportStaging } from "../../../../src/obsidian/fonts/font-import-staging";
import * as binaryResources from "../../../../src/persistence/serialization/binary-resource";
import { FONT_LIMITS } from "../../../../src/persistence/fonts/font-container";
import { readBundledFont } from "../../../fixtures/persistence/font-assets";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { vaultFontLibraryFixture } from "../../../fixtures/obsidian/vault-font-library";
import { FontImportSelection } from "../../../../src/obsidian/settings/fonts/font-import-selection";

const options = {
  descriptor: { family: "upload", weight: 400, style: "normal" },
  fallbackName: "regular.woff2",
  useMetadata: true,
} as const;

it("charges equal selections once across a batch and retains only the prior draft after a failed addition", async () => {
  const vault = await vaultFontLibraryFixture();
  const draft = new FontImportSelection(vault.library);
  const encode = vi.spyOn(binaryResources, "encodeBinaryResource");
  try {
    const copies = Array.from(
      { length: FONT_LIMITS.libraryFaces + 1 },
      (_, i) => new File([vault.bytes], `Inter-${i}.woff2`),
    );
    await draft.add(copies);
    expect(draft.files.map((face) => face.fileName)).toEqual([copies[0]!.name]);
    const bold = new File([await readBundledFont("inter-700-normal.woff2")], "Bold.woff2");
    const broken = new File([new Uint8Array(vault.bytes.length)], "Broken.woff2");
    await expect(draft.add([copies[1]!, bold, broken])).rejects.toMatchObject({
      code: "invalid-font",
    });
    expect(encode).toHaveBeenCalledTimes(2);
    expect(vault.sanitize).toHaveBeenCalledTimes(2);
    expect(vault.createBinary).not.toHaveBeenCalled();
    const entries = await vault.library.commitImport(draft.files, { displayName: "Inter" });
    expect(entries.map((entry) => entry.id)).toEqual([draft.files[0]!.id]);
    expect(vault.createBinary).toHaveBeenCalledOnce();
  } finally {
    encode.mockRestore();
    draft.dispose();
    vault.dispose();
  }
});

it("prepares each owned binary once through the shared resource pipeline and releases it without vault work", async () => {
  const bytes = await readBundledFont("inter-400-normal.woff2");
  const staging = new FontImportStaging();
  const sanitize = vi.fn(async () => undefined);
  const encode = vi.spyOn(binaryResources, "encodeBinaryResource");
  try {
    const prepared = await staging.prepare(bytes, options, new TestWorkScheduler(), sanitize);
    expect(encode).toHaveBeenCalledOnce();
    expect(encode.mock.calls[0]![0]).toEqual(bytes);
    expect(sanitize).toHaveBeenCalledOnce();
    const owned = staging.bytes(prepared);
    expect(owned).not.toBe(bytes);
    expect(owned).toEqual(bytes);
    staging.bytes(prepared);
    expect(encode).toHaveBeenCalledOnce();
    expect(sanitize).toHaveBeenCalledOnce();
    staging.release(prepared);
    expect(() => staging.bytes(prepared)).toThrow("no longer available");
    staging.dispose();
  } finally {
    encode.mockRestore();
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
