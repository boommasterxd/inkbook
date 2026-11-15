import type { FontResourceV2, ImageResourceV3 } from "../../../domain/schema/public";
import { fontStylesheetMarkupFragments } from "./text-fonts";
import { imageDefinitionsFragments } from "./image-markup";
import { parseSafeAutoDefinitionsSteps } from "../../documents/safe-svg-auto-definitions";
import { parseSafeAutoPaintDefinitionsSteps } from "../../documents/safe-svg-auto-servers";
import { parseOpeningTag } from "../../documents/svg-tag";
import { parseSafeSvgRoot } from "../../documents/svg-envelope-root";
import { FILE_SCHEMA_LIMITS } from "../../../domain/schema/public";

const CHUNK_CHARACTERS = 64 * 1024;

/** Independently bind the sole output payload to the authoritative font descriptors. */
export async function matchesCanonicalFontOutput(
  output: string | Uint8Array | undefined,
  fonts: readonly FontResourceV2[],
  checkpoint: () => Promise<void> | undefined,
  images: readonly ImageResourceV3[] = [],
): Promise<boolean> {
  if (output === undefined) return fonts.length === 0;
  const prefix =
    typeof output === "string"
      ? output.slice(0, 4096)
      : new TextDecoder().decode(output.subarray(0, 4096));
  const themeEnd = prefix.indexOf("</style>");
  if (themeEnd < 0) return false;
  let offset = themeEnd + 8;
  let work = 0;
  for (const token of expectedTokens(fonts, images)) {
    for (let start = 0; start < token.length;) {
      const end = Math.min(token.length, start + CHUNK_CHARACTERS - work);
      if (!matchesChunk(output, offset - start, token, start, end)) return false;
      work += end - start;
      offset += end - start;
      start = end;
      if (work === CHUNK_CHARACTERS) {
        const pending = checkpoint();
        if (pending !== undefined) await pending;
        work = 0;
      }
    }
  }
  const pending = checkpoint();
  if (pending !== undefined) await pending;
  return matchesFollowingMetadata({ output, prefix, offset, images, checkpoint });
}

async function matchesFollowingMetadata(options: {
  readonly output: string | Uint8Array;
  readonly prefix: string;
  readonly offset: number;
  readonly images: readonly ImageResourceV3[];
  readonly checkpoint: () => Promise<void> | undefined;
}): Promise<boolean> {
  const { output, prefix, images, checkpoint } = options;
  let offset = options.offset;
  const tag = parseOpeningTag(prefix, 0);
  const root = tag === null ? null : parseSafeSvgRoot(tag, "current");
  if (root === null) return false;
  if (root.version >= 5 && images.length > 0) {
    const auto = await readAutoDefinitions(output, offset, checkpoint);
    if (auto === null) return false;
    const steps = parseSafeAutoDefinitionsSteps(auto, 0, {
      height: root.height,
      resources: images,
      exhausted: () => true,
    });
    let step = steps.next();
    while (!step.done) {
      const pending = checkpoint();
      if (pending !== undefined) await pending;
      step = steps.next();
    }
    if (step.value !== auto.length) return false;
    offset += auto.length;
    const afterPaints = await readPaintDefinitions(output, offset, checkpoint);
    if (afterPaints === null) return false;
    offset = afterPaints;
  }
  return matchesChunk(output, offset, "<metadata ", 0, "<metadata ".length);
}

function* expectedTokens(
  fonts: readonly FontResourceV2[],
  images: readonly ImageResourceV3[],
): Iterable<string> {
  yield* fontStylesheetMarkupFragments(fonts);
  yield* imageDefinitionsFragments(images);
}

async function readAutoDefinitions(
  output: string | Uint8Array,
  offset: number,
  checkpoint: () => Promise<void> | undefined,
  ending = "</svg></defs>",
): Promise<string | null> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  let suffix = "";
  for (let cursor = offset; cursor < output.length; cursor += CHUNK_CHARACTERS) {
    if (cursor - offset >= FILE_SCHEMA_LIMITS.totalInputBytes) return null;
    const next = Math.min(output.length, cursor + CHUNK_CHARACTERS);
    const chunk =
      typeof output === "string"
        ? output.slice(cursor, next)
        : decoder.decode(output.subarray(cursor, next));
    const combined = suffix + chunk;
    const end = combined.indexOf(ending);
    if (end >= 0) {
      chunks.push(chunk.slice(0, end + ending.length - suffix.length));
      return chunks.join("");
    }
    chunks.push(chunk);
    suffix = combined.slice(-(ending.length - 1));
    const pending = checkpoint();
    if (pending !== undefined) await pending;
  }
  return null;
}

async function readPaintDefinitions(
  output: string | Uint8Array,
  offset: number,
  checkpoint: () => Promise<void> | undefined,
): Promise<number | null> {
  const markup = await readAutoDefinitions(output, offset, checkpoint, "</defs>");
  if (markup === null) return null;
  const steps = parseSafeAutoPaintDefinitionsSteps(markup, 0, { exhausted: () => true });
  let step = steps.next();
  while (!step.done) {
    const pending = checkpoint();
    if (pending !== undefined) await pending;
    step = steps.next();
  }
  return step.value?.next === markup.length ? offset + markup.length : null;
}

/** Bind both registries to their sole payload before accepting a worker's export. */
export async function matchesCanonicalImageOutput(
  output: string | Uint8Array | undefined,
  fonts: readonly FontResourceV2[],
  images: readonly ImageResourceV3[],
  checkpoint: () => Promise<void> | undefined,
): Promise<boolean> {
  if (output === undefined) return fonts.length === 0 && images.length === 0;
  return matchesCanonicalFontOutput(output, fonts, checkpoint, images);
}

function matchesChunk(
  output: string | Uint8Array,
  offset: number,
  expected: string,
  start: number,
  end: number,
): boolean {
  if (typeof output === "string")
    return output.slice(offset + start, offset + end) === expected.slice(start, end);
  for (let index = start; index < end; index++) {
    if (output[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}
