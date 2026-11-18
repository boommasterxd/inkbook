import { elementSnapshotVersion } from "../../../../domain/schema/snapshot-version";
import type {
  ClipboardElementBodyV1,
  ClipboardElementV1,
  InkClipboardV1,
  InkElementV1,
  FontResourceV2,
  ImageResourceV3,
} from "../../../../domain/schema/public";
import { CLIPBOARD_JSON_LIMITS, writeClipboardJsonSteps } from "../../../clipboard/canonical-json";
import { CLIPBOARD_LIMITS, INKBOOK_CLIPBOARD_TEXT_PREFIX } from "../../../clipboard/constants";
import type {
  ClipboardCandidates,
  ClipboardPayloadSource,
  ClipboardResult,
  ClipboardWritePayload,
  DecodedClipboard,
} from "../../../clipboard/types";
import { validateClipboardPayloadSliced } from "../../../clipboard/validation";
import { createClipboardBody, encodeRuntimeSelection } from "../../../clipboard/codec";
import type { IncrementalDocumentSerializer } from "../../../serialization/output/incremental-document-serializer";
import type { ClipboardStrokeFacts } from "../../../clipboard/validation";
import { usedImageResourcesSteps } from "../../../images/used-image-resources";
import { usedFontResourcesSteps } from "../../../fonts/used-font-resources";
import { bindTextElementFontResourcesSteps } from "../../../fonts/bound-font-resources";
import { consumeSerializationSteps } from "../../../serialization/output/serialization-model-preparation";
import { parseChunkedJson } from "../../../serialization/input/chunked-json-parser";
import { runtimeSliceWorkProfile } from "../slice-scheduler";
import type { RuntimeSliceContext, RuntimeSliceWorkProfile } from "../types";

const encoder = new TextEncoder();

export function missingClipboardSelection(): ClipboardResult<never> {
  return clipboardFailure("missing-selection", "The selection contains an unknown element.");
}

export function encodeRuntimeSelectionWrite(
  selected: readonly InkElementV1[],
  selectedIds: readonly string[],
  fontResources: readonly FontResourceV2[] = [],
  imageResources: readonly ImageResourceV3[] = [],
): ClipboardResult<ClipboardWritePayload> {
  const result = encodeRuntimeSelection(
    selected,
    new Set(selectedIds),
    fontResources,
    imageResources,
  );
  if (!result.ok) return result;
  const { byteLength, customText, plainText } = result.value;
  return { ok: true, value: { byteLength, customText, plainText } };
}
function runtimeWorkProfile(context: RuntimeSliceContext): RuntimeSliceWorkProfile {
  if (context.workProfile !== undefined) return context.workProfile;
  return runtimeSliceWorkProfile(context.sliceMilliseconds?.());
}

export function encodeModelSelection(
  selected: InkElementV1[],
  context: RuntimeSliceContext,
  model: IncrementalDocumentSerializer,
): Promise<ClipboardResult<ClipboardWritePayload>> {
  return encodeRuntimeSelectionChunked(
    selected,
    context,
    model.currentFontResources(),
    model.currentImageResources(),
    model,
  );
}

export async function encodeRuntimeSelectionChunked(
  records: readonly InkElementV1[],
  context: RuntimeSliceContext,
  fontResources: readonly FontResourceV2[] = [],
  imageResources: readonly ImageResourceV3[] = [],
  model?: IncrementalDocumentSerializer,
): Promise<ClipboardResult<ClipboardWritePayload>> {
  const profile = runtimeWorkProfile(context);
  if (records.length === 0) return clipboardFailure("empty-selection", "No elements are selected.");
  const hasImages = records.some((element) => element.kind === "image");
  let images: ImageResourceV3[];
  try {
    images = hasImages
      ? await consumeSerializationSteps(usedImageResourcesSteps(records, imageResources), context)
      : [];
  } catch {
    context.signal.throwIfAborted();
    return clipboardFailure(
      "invalid-schema",
      "The selection references an unavailable image resource.",
    );
  }
  const hasText = records.some((element) => element.kind === "text");
  const textSelection = hasText ? [...records] : [];
  const selected = hasText ? textSelection : records;
  const fonts = hasText
    ? await prepareSelectionFonts(textSelection, fontResources, context, model)
    : { ok: true as const, value: [] };
  if (!fonts.ok) return fonts;
  const { clipboardElements, strokes } = await consumeSerializationSteps(
    clipboardBodiesSteps(selected, profile.nodeLimit, model),
    context,
  );
  const payload: InkClipboardV1 = {
    elements: clipboardElements,
    format: "inkbook-elements",
    version: elementSnapshotVersion(selected),
    ...(hasText ? { fontResources: fonts.value } : {}),
    ...(hasImages ? { imageResources: images } : {}),
  };
  const validated = await validateClipboardPayloadSliced(
    payload,
    context.checkpoint,
    profile.nodeLimit,
    Math.max(1, Math.floor(profile.inputByteLimit / 24)),
    {
      strokes,
      ...(model !== undefined &&
      images.every((resource) => model.currentImageResources().includes(resource))
        ? { selectedImages: images }
        : {}),
      ...(model !== undefined &&
      fonts.value.every((resource) => model.currentFontResources().includes(resource))
        ? { selectedFonts: fonts.value }
        : {}),
    },
  );
  if (!validated.ok) return validated;
  const encoded = await consumeSerializationSteps(
    writeClipboardJsonSteps(payload, true, profile),
    context,
  );
  if (!encoded.ok) return encoded;
  return {
    ok: true,
    value: {
      byteLength: encoded.value.byteLength,
      customText: encoded.value.text,
      plainText: `${INKBOOK_CLIPBOARD_TEXT_PREFIX}${encoded.value.text}`,
    },
  };
}

function* clipboardBodiesSteps(
  selected: readonly InkElementV1[],
  nodeLimit: number,
  model?: IncrementalDocumentSerializer,
) {
  const documentIds = new Map<string, string>();
  for (let index = 0; index < selected.length; index += 1) {
    documentIds.set(selected[index]!.id, compactClipId(index));
    if ((index + 1) % nodeLimit === 0) yield;
  }
  const clipboardElements: ClipboardElementV1[] = [];
  const strokes = new Map<ClipboardElementBodyV1, ClipboardStrokeFacts>();
  for (let index = 0; index < selected.length; index += 1) {
    const element = selected[index]!;
    const body = createClipboardBody(element, documentIds);
    if (element.kind === "stroke") {
      const facts = model?.currentElementFacts(element);
      if (facts !== undefined) strokes.set(body, { element, spatial: facts });
    }
    clipboardElements.push({
      clipId: compactClipId(index),
      element: body,
    });
    if ((index + 1) % nodeLimit === 0) yield;
  }
  return { clipboardElements, strokes };
}

/** Bind private selected records before body creation, preserving the source store records. */
async function prepareSelectionFonts(
  elements: InkElementV1[],
  resources: readonly FontResourceV2[],
  context: RuntimeSliceContext,
  model?: IncrementalDocumentSerializer,
): Promise<ClipboardResult<FontResourceV2[]>> {
  try {
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index]!;
      if (element.kind === "text" && model?.currentElementFacts(element) === undefined)
        elements[index] = await consumeSerializationSteps(
          bindTextElementFontResourcesSteps(element, resources),
          context,
        );
    }
    return {
      ok: true,
      value: await consumeSerializationSteps(usedFontResourcesSteps(elements, resources), context),
    };
  } catch (error) {
    context.signal.throwIfAborted();
    if (error instanceof RangeError)
      return clipboardFailure(
        "invalid-schema",
        "The selection references an unavailable font face.",
      );
    throw error;
  }
}

export async function decodeClipboardChunked(
  candidates: ClipboardCandidates,
  context: RuntimeSliceContext,
): Promise<ClipboardResult<DecodedClipboard>> {
  for (const candidate of clipboardCandidates(candidates)) {
    const decoded = await decodeCandidate(candidate.text, candidate.source, context);
    if (decoded.ok) return decoded;
  }
  return clipboardFailure("invalid-schema", "No valid Inkbook clipboard payload is available.");
}

async function decodeCandidate(
  input: string,
  source: ClipboardPayloadSource,
  context: RuntimeSliceContext,
): Promise<ClipboardResult<DecodedClipboard>> {
  const json =
    source === "plain"
      ? input.startsWith(INKBOOK_CLIPBOARD_TEXT_PREFIX)
        ? input.slice(INKBOOK_CLIPBOARD_TEXT_PREFIX.length)
        : null
      : input;
  if (json === null) return clipboardFailure("invalid-prefix", "Plain text is not Inkbook data.");
  const profile = runtimeWorkProfile(context);
  const inputBytes = await utf8ByteLength(input, context, profile.inputByteLimit);
  if (inputBytes > CLIPBOARD_LIMITS.totalInputBytes) {
    return clipboardFailure("limit-exceeded", "Clipboard input exceeds the 8 MiB input limit.");
  }
  let value: unknown;
  try {
    value = await parseChunkedJson(json, {
      batchCharacters: profile.inputByteLimit,
      checkpoint: context.checkpoint,
      limits: {
        ...CLIPBOARD_JSON_LIMITS,
        maximumStringScratchCharacters: profile.inputByteLimit,
      },
      signal: context.signal,
    });
  } catch {
    return clipboardFailure("invalid-json", "Clipboard JSON is malformed.");
  }
  const pending = context.checkpoint();
  if (pending !== undefined) await pending;
  const validated = await validateClipboardPayloadSliced(
    value,
    context.checkpoint,
    profile.nodeLimit,
    Math.max(1, Math.floor(profile.inputByteLimit / 24)),
  );
  if (!validated.ok) return validated;
  const canonical = await consumeSerializationSteps(
    writeClipboardJsonSteps(validated.value, false, profile),
    context,
  );
  if (!canonical.ok) return canonical;
  return {
    ok: true,
    value: {
      byteLength: canonical.value.byteLength,
      compactJson: canonical.value.text,
      customText: canonical.value.text,
      fingerprint: canonical.value.text,
      payload: validated.value,
      plainText: `${INKBOOK_CLIPBOARD_TEXT_PREFIX}${canonical.value.text}`,
      source,
    },
  };
}

function clipboardCandidates(
  candidates: ClipboardCandidates,
): readonly { readonly source: ClipboardPayloadSource; readonly text: string }[] {
  const available: { source: ClipboardPayloadSource; text: string }[] = [];
  if (candidates.customText !== undefined)
    available.push({ source: "custom", text: candidates.customText });
  if (candidates.plainText !== undefined)
    available.push({ source: "plain", text: candidates.plainText });
  if (candidates.sessionText !== undefined)
    available.push({ source: "session", text: candidates.sessionText });
  return available;
}

async function utf8ByteLength(
  value: string,
  context: RuntimeSliceContext,
  chunkCodeUnits = runtimeWorkProfile(context).inputByteLimit,
): Promise<number> {
  let bytes = 0;
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + chunkCodeUnits);
    const trailing = value.charCodeAt(end - 1);
    if (end < value.length && trailing >= 0xd800 && trailing <= 0xdbff) end -= 1;
    bytes += encoder.encode(value.slice(offset, end)).byteLength;
    if (bytes > CLIPBOARD_LIMITS.totalInputBytes) return bytes;
    const pending = context.checkpoint();
    if (pending !== undefined) await pending;
    offset = end;
  }
  return bytes;
}

function compactClipId(index: number): string {
  return index.toString(36);
}

function clipboardFailure(
  code:
    | "empty-selection"
    | "invalid-json"
    | "invalid-prefix"
    | "invalid-schema"
    | "limit-exceeded"
    | "missing-selection",
  message: string,
): ClipboardResult<never> {
  return { error: { code, message }, ok: false };
}
