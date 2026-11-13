import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { FONT_LIMITS, fontTag, invalidFont } from "./font-container";
import { inspectFont } from "./font-validation";
import { readFontFamilyName, readFontWeightRange } from "./font-name-table";
import { readWoff2MetadataTables } from "./woff2-metadata";

export interface ImportedFontMetadata {
  readonly familyName?: string;
  readonly weight: number;
  readonly style: "normal" | "italic";
  readonly weightRange?: readonly [number, number];
}

const TABLE_LIMITS = new Map([
  ["name", 256 * 1024],
  ["OS/2", 4096],
  ["fvar", 64 * 1024],
  ["head", 4096],
]);

/** Font names and descriptors come from the actual bounded font tables in every format. */
export async function readImportedFontMetadata(
  bytes: Uint8Array,
  scheduler: WorkScheduler,
  signal?: AbortSignal,
): Promise<ImportedFontMetadata> {
  signal?.throwIfAborted();
  const container = inspectFont(bytes);
  if (container.mimeType === "font/woff2")
    return metadataFromTables(
      await readWoff2MetadataTables(bytes, TABLE_LIMITS, scheduler, signal),
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const woff = container.mimeType === "font/woff";
  const header = woff ? 44 : 12;
  const stride = woff ? 20 : 16;
  const tables = new Map<string, Uint8Array>();
  for (let index = 0; index < container.tables; index += 1) {
    const offset = header + index * stride;
    const tag = fontTag(view, offset);
    const maximum = TABLE_LIMITS.get(tag);
    if (maximum === undefined) continue;
    const start = view.getUint32(offset + (woff ? 4 : 8));
    const length = view.getUint32(offset + (woff ? 8 : 12));
    const original = woff ? view.getUint32(offset + 12) : length;
    if (original > maximum) invalidFont();
    const source = bytes.subarray(start, start + length);
    tables.set(
      tag,
      length === original ? source : await inflateFontTable(source, original, scheduler, signal),
    );
    const pending = scheduler.checkpoint(signal, "background");
    if (pending !== undefined) await pending;
    signal?.throwIfAborted();
  }
  return metadataFromTables(tables);
}

function metadataFromTables(tables: ReadonlyMap<string, Uint8Array>): ImportedFontMetadata {
  const os2 = tables.get("OS/2");
  const head = tables.get("head");
  let weight = 400;
  let italic = false;
  if (os2 !== undefined && os2.length >= 64) {
    const view = new DataView(os2.buffer, os2.byteOffset, os2.length);
    weight = view.getUint16(4);
    italic = (view.getUint16(62) & 0x201) !== 0;
  } else if (head !== undefined && head.length >= 46) {
    const flags = new DataView(head.buffer, head.byteOffset, head.length).getUint16(44);
    weight = (flags & 1) === 0 ? 400 : 700;
    italic = (flags & 2) !== 0;
  }
  if (weight < 1 || weight > 1000) invalidFont();
  const name = tables.get("name");
  const familyName = name === undefined ? undefined : readFontFamilyName(name);
  const fvar = tables.get("fvar");
  const weightRange = fvar === undefined ? undefined : readFontWeightRange(fvar);
  return {
    weight,
    style: italic ? "italic" : "normal",
    ...(familyName === undefined ? {} : { familyName }),
    ...(weightRange === undefined ? {} : { weightRange }),
  };
}

async function inflateFontTable(
  source: Uint8Array,
  expected: number,
  scheduler: WorkScheduler,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (expected > FONT_LIMITS.decodedBytes) invalidFont();
  const owned = new Uint8Array(source);
  const stream = new Blob([owned]).stream().pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  const output = new Uint8Array(expected);
  let offset = 0;
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      if (chunk.value.length > expected - offset) invalidFont();
      output.set(chunk.value, offset);
      offset += chunk.value.length;
      const pending = scheduler.checkpoint(signal, "background");
      if (pending !== undefined) await pending;
      signal?.throwIfAborted();
      chunk = await reader.read();
    }
    if (offset !== expected) invalidFont();
    return output;
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
