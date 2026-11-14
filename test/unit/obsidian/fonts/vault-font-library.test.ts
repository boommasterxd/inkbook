import type { Component, TFile, Vault } from "obsidian";
import { expect, it, vi } from "vitest";
import {
  VaultFontLibrary,
  type LibraryFontFace,
} from "../../../../src/obsidian/fonts/vault-font-library";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { selectFontResources } from "../../../../src/persistence/fonts/font-resources";
import { fontLibraryChoices } from "../../../../src/obsidian/fonts/font-library-families";
import { readWoff2Directory } from "../../../../src/persistence/fonts/woff2-directory";
import { readBundledFont as fontBytes } from "../../../fixtures/persistence/font-assets";
import { ChunkedSha256 } from "../../../../src/persistence/serialization/chunked-output-sha256";

async function setup(name = "inter-400-normal.woff2") {
  const bytes = await fontBytes(name);
  let index: readonly LibraryFontFace[] = [];
  const data = new Map<string, ArrayBuffer>();
  const createBinary = vi.fn(async (path: string, content: ArrayBuffer) => {
    data.set(path, content.slice(0));
  });
  const getFileByPath = (path: string) =>
    data.has(path) ? ({ path, stat: { size: data.get(path)!.byteLength } } as TFile) : null;
  const vault = {
    getAbstractFileByPath: () => ({}),
    getFileByPath,
    createBinary,
    readBinary: async (file: TFile) => data.get(file.path)!.slice(0),
  } as unknown as Vault;
  let dispose: () => void = () => undefined;
  const owner = {
    register: (callback: () => void) => {
      dispose = callback;
    },
  } as unknown as Component;
  const sanitize = vi.fn(async () => undefined);
  const metadataWrite = vi.fn(async (faces: readonly LibraryFontFace[]) => {
    index = faces;
  });
  const library = new VaultFontLibrary({
    vault,
    owner,
    scheduler: new TestWorkScheduler(),
    metadata: {
      read: () => index,
      write: metadataWrite,
    },
    sanitize,
  });
  return {
    library,
    bytes,
    createBinary,
    sanitize,
    data,
    metadataWrite,
    setIndex: (faces: readonly LibraryFontFace[]) => {
      index = faces;
    },
    dispose: () => dispose(),
  };
}

const descriptor = { family: "upload", weight: 400, style: "normal" } as const;

async function importBold(
  context: Awaited<ReturnType<typeof setup>>,
  name: string,
  family: string = descriptor.family,
) {
  return context.library.import(
    await fontBytes("inter-700-normal.woff2"),
    { ...descriptor, family, weight: 700 },
    name,
  );
}

it("renames every variant in one family without touching other families or font data", async () => {
  const context = await setup();
  const regular = await context.library.import(context.bytes, descriptor, "Same name");
  const bold = await importBold(context, "Same name", regular.family);
  const other = await context.library.import(
    await fontBytes("source-serif-400-normal.woff2"),
    descriptor,
    "Same name",
  );
  context.metadataWrite.mockClear();
  context.createBinary.mockClear();
  context.sanitize.mockClear();
  const data = [...context.data.entries()];
  await context.library.renameFamily(regular.family, "  Headings  ");
  expect(context.library.list()).toEqual([
    { ...regular, displayName: "Headings" },
    { ...bold, displayName: "Headings" },
    other,
  ]);
  expect(context.metadataWrite).toHaveBeenCalledOnce();
  expect(context.createBinary).not.toHaveBeenCalled();
  expect(context.sanitize).not.toHaveBeenCalled();
  expect([...context.data.entries()]).toEqual(data);
  await context.library.renameFamily(regular.family, " Headings ");
  expect(context.metadataWrite).toHaveBeenCalledOnce();
});

it("rejects invalid names and missing families and recovers after a failed rename write", async () => {
  const context = await setup();
  const face = await context.library.import(context.bytes, descriptor, "Original");
  context.metadataWrite.mockClear();
  for (const name of ["  ", "x".repeat(129)]) {
    await expect(context.library.renameFamily(face.family, name)).rejects.toMatchObject({
      code: "invalid-name",
    });
  }
  await expect(context.library.renameFamily("missing", "Valid")).rejects.toMatchObject({
    code: "unavailable-family",
  });
  expect(context.metadataWrite).not.toHaveBeenCalled();
  context.metadataWrite.mockRejectedValueOnce(new Error("Disk unavailable"));
  await expect(context.library.renameFamily(face.family, "Renamed")).rejects.toThrow(
    "Disk unavailable",
  );
  expect(context.library.list()).toEqual([face]);
  await context.library.renameFamily(face.family, "Renamed");
  expect(context.library.list()).toEqual([{ ...face, displayName: "Renamed" }]);
});

it("joins separate Regular and Bold files only through an explicitly selected family", async () => {
  const context = await setup();
  const regular = await context.library.import(context.bytes, descriptor, "Inter");
  const bold = await importBold(context, "Inter", regular.family);
  expect(bold.family).toBe(regular.family);
  expect(bold.id).not.toBe(regular.id);
  const resources = await Promise.all([
    context.library.resource(regular),
    context.library.resource(bold),
  ]);
  expect(
    selectFontResources(resources, [{ family: regular.family, weight: 700, style: "normal" }]),
  ).toEqual([resources[1]]);
  expect(
    selectFontResources([resources[0]], [{ family: regular.family, weight: 700, style: "italic" }]),
  ).toEqual([resources[0]]);
  expect(fontLibraryChoices(context.library.list())).toEqual([
    { label: "Inter", value: regular.family },
  ]);
});

it("keeps equal names separate and never replaces overlapping faces", async () => {
  const context = await setup();
  const regular = await context.library.import(context.bytes, descriptor, "Same name");
  const bold = await importBold(context, "Same name");
  expect(bold.family).not.toBe(regular.family);
  expect(fontLibraryChoices(context.library.list())).toEqual([
    { label: "Same name", value: regular.family },
    { label: "Same name", value: bold.family },
  ]);
  await expect(
    context.library.import(
      await fontBytes("source-serif-400-normal.woff2"),
      { ...descriptor, family: regular.family },
      "Same name",
    ),
  ).rejects.toThrow("already contains");
  expect(context.library.list()).toHaveLength(2);
  expect(context.createBinary).toHaveBeenCalledTimes(2);
});
it("deduplicates imports by content and face and snapshots survive library removal", async () => {
  const context = await setup();
  const face = await context.library.import(context.bytes, descriptor, "My font");
  expect(face.family).toMatch(/^custom-[a-f0-9]{64}$/);
  const duplicate = await context.library.import(context.bytes, descriptor, "Another name");
  expect(duplicate).toEqual(face);
  expect(context.createBinary).toHaveBeenCalledTimes(1);
  const snapshot = await context.library.resource(face);
  expect(snapshot).not.toHaveProperty("path");
  expect(snapshot).not.toHaveProperty("displayName");
  await context.library.remove(face.id);
  expect(context.library.list()).toEqual([]);
  expect(snapshot.data.length).toBeGreaterThan(0);
  await expect(
    context.library.import(context.bytes, { ...descriptor, family: face.family }, "Stale choice"),
  ).rejects.toThrow("unavailable");
  expect(context.library.list()).toEqual([]);
  expect(context.createBinary).toHaveBeenCalledTimes(1);
});

it("detects actual SFNT and WOFF2 metadata instead of guessing from filenames", async () => {
  const context = await setup("caveat-variable.ttf");
  const face = await context.library.import(
    context.bytes,
    { family: "upload", weight: 700, style: "italic" },
    "Filename is not a family",
    true,
  );
  expect(face.displayName).toBe("Caveat");
  expect(face.weight).toBe(400);
  expect(face.style).toBe("normal");
  expect(face.weightRange).toEqual([400, 700]);
  const woff2 = await setup();
  const detected = await woff2.library.import(woff2.bytes, descriptor, "Unknown face", true);
  expect(detected.displayName).toBe("Inter");
  expect(detected.weight).toBe(400);
  expect(detected.style).toBe("normal");
});

it("does not persist a font rejected by native sanitization", async () => {
  const context = await setup();
  context.sanitize.mockRejectedValueOnce(new Error("Invalid font tables"));
  await expect(context.library.import(context.bytes, descriptor, "Bad font")).rejects.toThrow(
    "Invalid font tables",
  );
  expect(context.createBinary).not.toHaveBeenCalled();
  expect(context.library.list()).toEqual([]);
});

it("does not write or admit a WOFF2 whose compressed table stream requests a nonstandard window", async () => {
  const context = await setup();
  const directory = readWoff2Directory(new DataView(context.bytes.buffer));
  context.bytes[directory.compressedOffset] = 0x11;
  await expect(
    context.library.import(context.bytes, descriptor, "Invalid font", true),
  ).rejects.toThrow();
  expect(context.createBinary).not.toHaveBeenCalled();
  expect(context.sanitize).not.toHaveBeenCalled();
  expect(context.library.list()).toEqual([]);
});

it("rejects changed vault binaries and operations after owner disposal", async () => {
  const context = await setup();
  const face = await context.library.import(context.bytes, descriptor, "My font");
  const changed = context.data.get(face.path)!;
  const changedBytes = new Uint8Array(changed);
  changedBytes[changed.byteLength - 1] = changedBytes[changed.byteLength - 1]! ^ 1;
  await expect(context.library.resource(face)).rejects.toThrow("content changed");
  context.dispose();
  expect(() => context.library.list()).toThrow("disposed");
  await expect(context.library.import(context.bytes, descriptor, "After unload")).rejects.toThrow(
    "disposed",
  );
});

it("prepares read-only previews and commits named variants once without repeating expensive work", async () => {
  const context = await setup();
  const hash = vi.spyOn(ChunkedSha256.prototype, "update");
  try {
    const regular = await context.library.prepareImport(context.bytes, "regular.woff2");
    const bold = await context.library.prepareImport(
      await fontBytes("inter-700-normal.woff2"),
      "bold.woff2",
    );
    expect(regular).toMatchObject({
      familyName: "Inter",
      weight: 400,
      style: "normal",
      fileName: "regular.woff2",
    });
    expect(context.library.list()).toEqual([]);
    expect(context.createBinary).not.toHaveBeenCalled();
    expect(context.metadataWrite).not.toHaveBeenCalled();
    const hashReads = hash.mock.calls.length;
    expect(hashReads).toBe(
      Math.ceil(context.bytes.length / 4096) +
        Math.ceil((await fontBytes("inter-700-normal.woff2")).length / 4096),
    );
    context.bytes.fill(0);
    const imported = await context.library.commitImport([regular, bold, regular], {
      displayName: "My headings",
    });
    expect(imported).toHaveLength(2);
    expect(imported[0]!.family).toBe(imported[1]!.family);
    expect(imported.map((face) => face.displayName)).toEqual(["My headings", "My headings"]);
    expect(context.metadataWrite).toHaveBeenCalledOnce();
    expect(context.createBinary).toHaveBeenCalledTimes(2);
    expect(context.sanitize).toHaveBeenCalledTimes(2);
    expect(hash).toHaveBeenCalledTimes(hashReads);
    expect(new Uint8Array(context.data.get(imported[0]!.path)!)).not.toEqual(context.bytes);
    await expect(
      context.library.commitImport([regular], { displayName: "Again" }),
    ).rejects.toMatchObject({ code: "invalid-prepared" });
  } finally {
    hash.mockRestore();
  }
});

it("retains an explicitly chosen group's name and refuses implicit duplicate reassignment", async () => {
  const context = await setup();
  const existing = await context.library.import(context.bytes, descriptor, "Existing name");
  const duplicate = await context.library.prepareImport(context.bytes, "regular.woff2");
  await expect(
    context.library.commitImport([duplicate], { displayName: "New name" }),
  ).rejects.toMatchObject({ code: "duplicate-family" });
  const bold = await context.library.prepareImport(
    await fontBytes("inter-700-normal.woff2"),
    "bold.woff2",
  );
  const imported = await context.library.commitImport([duplicate, bold], {
    displayName: "Ignored",
    family: existing.family,
  });
  expect(imported[0]).toEqual(existing);
  expect(imported[1]).toMatchObject({
    family: existing.family,
    displayName: "Existing name",
    weight: 700,
  });
  expect(context.createBinary).toHaveBeenCalledTimes(2);
  expect(context.library.list()).toHaveLength(2);
});

it("rejects overlapping staged variants before writing any binary", async () => {
  const context = await setup();
  const regular = await context.library.prepareImport(context.bytes, "regular.woff2");
  const other = await context.library.prepareImport(
    await fontBytes("source-serif-400-normal.woff2"),
    "other.woff2",
  );
  await expect(
    context.library.commitImport([regular, other], { displayName: "Conflicting" }),
  ).rejects.toMatchObject({ code: "face-conflict" });
  expect(context.createBinary).not.toHaveBeenCalled();
  expect(context.metadataWrite).not.toHaveBeenCalled();
  context.library.releasePrepared(regular);
  context.library.releasePrepared(other);
});

it("rechecks live capacity and selected family after preparation", async () => {
  const context = await setup();
  const prepared = await context.library.prepareImport(context.bytes, "regular.woff2");
  await expect(
    context.library.commitImport([prepared], {
      displayName: "Inter",
      family: `custom-${"a".repeat(64)}`,
    }),
  ).rejects.toMatchObject({ code: "unavailable-family" });
  context.setIndex(
    Array.from({ length: 128 }, (_, index) => ({
      ...descriptor,
      id: index.toString(16).padStart(64, "0"),
      path: "unused",
      family: `custom-${index.toString(16).padStart(64, "0")}`,
      displayName: "Other",
    })),
  );
  await expect(
    context.library.commitImport([prepared], { displayName: "Inter" }),
  ).rejects.toMatchObject({ code: "library-full" });
  expect(context.createBinary).not.toHaveBeenCalled();
  expect(context.metadataWrite).not.toHaveBeenCalled();
});

it("keeps cancellation, release, forgery and owner disposal read-only", async () => {
  const context = await setup();
  const controller = new AbortController();
  context.sanitize.mockImplementationOnce(async () => {
    controller.abort();
  });
  await expect(
    context.library.prepareImport(context.bytes, "regular.woff2", controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  const prepared = await context.library.prepareImport(context.bytes, "regular.woff2");
  await expect(
    context.library.commitImport([{ ...prepared }], { displayName: "Forged" }),
  ).rejects.toMatchObject({ code: "invalid-prepared" });
  context.library.releasePrepared(prepared);
  context.library.releasePrepared(prepared);
  await expect(
    context.library.commitImport([prepared], { displayName: "Released" }),
  ).rejects.toMatchObject({ code: "invalid-prepared" });
  const staged = await context.library.prepareImport(context.bytes, "regular.woff2");
  context.dispose();
  await expect(context.library.commitImport([staged], { displayName: "Disposed" })).rejects.toThrow(
    "disposed",
  );
  expect(context.createBinary).not.toHaveBeenCalled();
  expect(context.metadataWrite).not.toHaveBeenCalled();
});

it("preserves current external metadata when it changes while vault I/O is pending", async () => {
  const context = await setup();
  const prepared = await context.library.prepareImport(context.bytes, "regular.woff2");
  const external = {
    ...descriptor,
    id: "a".repeat(64),
    family: `custom-${"a".repeat(64)}`,
    path: "external.woff2",
    displayName: "External font",
  };
  context.createBinary.mockImplementationOnce(async (path, content) => {
    context.data.set(path, content.slice(0));
    context.setIndex([external]);
  });
  await context.library.commitImport([prepared], { displayName: "Inter" });
  expect(context.library.list()).toContainEqual(external);
  expect(context.library.list()).toHaveLength(2);
  expect(context.metadataWrite).toHaveBeenCalledOnce();
});

it("retains reviewed bytes for a retry after metadata persistence fails", async () => {
  const context = await setup();
  const prepared = await context.library.prepareImport(context.bytes, "regular.woff2");
  context.metadataWrite.mockRejectedValueOnce(new Error("Disk unavailable"));
  await expect(context.library.commitImport([prepared], { displayName: "Inter" })).rejects.toThrow(
    "Disk unavailable",
  );
  expect(context.library.list()).toEqual([]);
  await context.library.commitImport([prepared], { displayName: "Retry name" });
  expect(context.library.list()[0]!.displayName).toBe("Retry name");
  expect(context.sanitize).toHaveBeenCalledOnce();
  expect(context.createBinary).toHaveBeenCalledOnce();
});
