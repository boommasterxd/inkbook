import { CLIPBOARD_LIMITS, INKBOOK_CLIPBOARD_TEXT_PREFIX } from "../../../clipboard/constants";
import type {
  ClipboardResult,
  ClipboardWritePayload,
  DecodedClipboard,
} from "../../../clipboard/types";
import { adoptUtf8Output } from "../../../scheduling/utf8-adoption";
import { type PackedClipboardPayload, unpackClipboardPayload } from "./clipboard-wire-payload";
import type { RuntimeWireSliceOptions } from "./element-wire-codec";
import { isNativeArrayBuffer, isNativeUint8Array } from "../../../serialization/transfer-array";

export interface PackedClipboardText {
  readonly byteLength: number;
  readonly canonicalText: Uint8Array;
}

export interface PackedDecodedClipboard extends PackedClipboardText {
  readonly payload: PackedClipboardPayload;
  readonly source: DecodedClipboard["source"];
}

export function packClipboardText(value: ClipboardWritePayload): PackedClipboardText {
  const canonicalText = new TextEncoder().encode(value.customText);
  if (
    value.byteLength !== canonicalText.byteLength ||
    value.byteLength > CLIPBOARD_LIMITS.totalInputBytes ||
    value.plainText !== `${INKBOOK_CLIPBOARD_TEXT_PREFIX}${value.customText}`
  ) {
    throw new TypeError("Clipboard result does not match the canonical wire representation.");
  }
  return { byteLength: value.byteLength, canonicalText };
}

function unpackClipboardText(value: PackedClipboardText): ClipboardWritePayload {
  validatePackedClipboardText(value);
  return clipboardWritePayload(new TextDecoder().decode(value.canonicalText), value.byteLength);
}

async function unpackClipboardTextChunked(
  value: PackedClipboardText,
  options: RuntimeWireSliceOptions,
): Promise<ClipboardWritePayload> {
  validatePackedClipboardText(value);
  const customText = await adoptUtf8Output(value.canonicalText, options);
  return clipboardWritePayload(customText, value.byteLength);
}

export function unpackClipboardWriteResult(
  result: ClipboardResult<PackedClipboardText>,
): ClipboardResult<ClipboardWritePayload> {
  return result.ok ? { ok: true, value: unpackClipboardText(result.value) } : result;
}

export async function unpackClipboardWriteResultChunked(
  result: ClipboardResult<PackedClipboardText>,
  options: RuntimeWireSliceOptions,
): Promise<ClipboardResult<ClipboardWritePayload>> {
  if (!result.ok) return result;
  return { ok: true, value: await unpackClipboardTextChunked(result.value, options) };
}

export function unpackDecodedClipboardResult(
  result: ClipboardResult<PackedDecodedClipboard>,
): ClipboardResult<DecodedClipboard> {
  return result.ok ? { ok: true, value: decodedClipboard(result.value) } : result;
}

export async function unpackDecodedClipboardResultChunked(
  result: ClipboardResult<PackedDecodedClipboard>,
  options: RuntimeWireSliceOptions,
): Promise<ClipboardResult<DecodedClipboard>> {
  if (!result.ok) return result;
  return {
    ok: true,
    value: decodedClipboard(result.value, await unpackClipboardTextChunked(result.value, options)),
  };
}

function validatePackedClipboardText(value: PackedClipboardText): void {
  if (
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 0 ||
    value.byteLength > CLIPBOARD_LIMITS.totalInputBytes ||
    !isNativeUint8Array(value.canonicalText) ||
    value.canonicalText.byteLength !== value.byteLength ||
    !isNativeArrayBuffer(value.canonicalText.buffer) ||
    value.canonicalText.byteOffset !== 0 ||
    value.canonicalText.byteLength !== value.canonicalText.buffer.byteLength
  ) {
    throw new TypeError("Clipboard wire text exceeds its limit or has an invalid byte length.");
  }
}

function clipboardWritePayload(customText: string, byteLength: number): ClipboardWritePayload {
  return {
    byteLength,
    customText,
    plainText: `${INKBOOK_CLIPBOARD_TEXT_PREFIX}${customText}`,
  };
}

function decodedClipboard(
  value: PackedDecodedClipboard,
  text = unpackClipboardText(value),
): DecodedClipboard {
  return {
    ...text,
    compactJson: text.customText,
    fingerprint: text.customText,
    payload: unpackClipboardPayload(value.payload),
    source: value.source,
  };
}
