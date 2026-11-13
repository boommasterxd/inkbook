import { expect, it, vi } from "vitest";
import { readImportedFontMetadata } from "../../../../src/persistence/fonts/font-metadata";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { readBundledFont as font } from "../../../fixtures/persistence/font-assets";

const scheduler = new TestWorkScheduler();

async function wrapWoff(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const original = new DataView(bytes.buffer);
  const count = original.getUint16(4);
  const tables: {
    tag: number;
    checksum: number;
    data: Uint8Array<ArrayBuffer>;
    original: number;
  }[] = [];
  let decodedBytes = 12 + count * 16;
  for (let index = 0; index < count; index += 1) {
    const offset = 12 + index * 16;
    const length = original.getUint32(offset + 12);
    const source = bytes.slice(
      original.getUint32(offset + 8),
      original.getUint32(offset + 8) + length,
    );
    const compressed = new Uint8Array(
      await new Response(
        new Blob([source]).stream().pipeThrough(new CompressionStream("deflate")),
      ).arrayBuffer(),
    );
    tables.push({
      tag: original.getUint32(offset),
      checksum: original.getUint32(offset + 4),
      data: compressed.length < length ? compressed : source,
      original: length,
    });
    decodedBytes += Math.ceil(length / 4) * 4;
  }
  const size =
    44 + count * 20 + tables.reduce((sum, table) => sum + Math.ceil(table.data.length / 4) * 4, 0);
  const output = new Uint8Array(size);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x774f4646);
  view.setUint32(4, original.getUint32(0));
  view.setUint32(8, size);
  view.setUint16(12, count);
  view.setUint32(16, decodedBytes);
  let position = 44 + count * 20;
  for (const [index, table] of tables.entries()) {
    const offset = 44 + index * 20;
    view.setUint32(offset, table.tag);
    view.setUint32(offset + 4, position);
    view.setUint32(offset + 8, table.data.length);
    view.setUint32(offset + 12, table.original);
    view.setUint32(offset + 16, table.checksum);
    output.set(table.data, position);
    position += Math.ceil(table.data.length / 4) * 4;
  }
  return output;
}

it("extracts actual Unicode family, weight, style and variable weight range from SFNT", async () => {
  await expect(
    readImportedFontMetadata(await font("caveat-variable.ttf"), scheduler),
  ).resolves.toEqual({
    familyName: "Caveat",
    weight: 400,
    style: "normal",
    weightRange: [400, 700],
  });
});

it("extracts the same metadata from bounded deflate-compressed WOFF tables", async () => {
  const bytes = await font("caveat-variable.ttf");
  const woff = await wrapWoff(bytes);
  await expect(readImportedFontMetadata(woff, scheduler)).resolves.toEqual(
    await readImportedFontMetadata(bytes, scheduler),
  );
});

it("extracts actual family and face metadata from every bundled WOFF2 without fetching", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    for (const [prefix, familyName] of [
      ["inter", "Inter"],
      ["source-serif", "Source Serif 4"],
      ["jetbrains-mono", "JetBrains Mono"],
    ]) {
      for (const weight of [400, 700]) {
        for (const style of ["normal", "italic"]) {
          await expect(
            readImportedFontMetadata(await font(`${prefix}-${weight}-${style}.woff2`), scheduler),
          ).resolves.toEqual({
            familyName,
            weight: prefix === "jetbrains-mono" && weight === 700 ? 558 : weight,
            style,
          });
        }
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
