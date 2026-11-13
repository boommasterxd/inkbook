import {
  CLIPBOARD_LIMITS,
  INKBOOK_CLIPBOARD_TEXT_PREFIX,
  INKBOOK_CLIPBOARD_WEB_MIME,
} from "../../../persistence/clipboard/constants";
import type { ClipboardCandidates } from "../../../persistence/clipboard/types";
import { MAX_TEXT_SOURCE_LENGTH } from "../../../domain/schema/text-validation-primitives";

const SUPPORTED_MIME_TYPES = [INKBOOK_CLIPBOARD_WEB_MIME, "text/markdown", "text/plain"] as const;
const MAX_CANDIDATE_BLOB_BYTES = CLIPBOARD_LIMITS.totalInputBytes * 2;
export const MAX_CLIPBOARD_ITEMS = 256;

export interface TextClipboardCandidates extends ClipboardCandidates {
  readonly markdownText?: string;
}

interface CandidateBlob {
  readonly blob: Blob;
  readonly mime: (typeof SUPPORTED_MIME_TYPES)[number];
}

class ClipboardCandidateLimitError extends Error {}

export interface SynchronousClipboardData {
  readonly types: readonly string[];
  getData(mime: string): string;
}

export function readSynchronousClipboardCandidates(
  data: SynchronousClipboardData | null,
): TextClipboardCandidates | null {
  if (data === null) return null;
  let customCandidate: string | undefined;
  let plainCandidate: string | undefined;
  let markdownCandidate: string | undefined;
  try {
    customCandidate = data.types.includes(INKBOOK_CLIPBOARD_WEB_MIME)
      ? data.getData(INKBOOK_CLIPBOARD_WEB_MIME)
      : undefined;
    plainCandidate = data.types.includes("text/plain") ? data.getData("text/plain") : undefined;
    markdownCandidate = data.types.includes("text/markdown")
      ? data.getData("text/markdown")
      : undefined;
  } catch {
    return null;
  }
  const customText = customCandidate;
  const plainText = plainCandidate === "" ? undefined : plainCandidate;
  const markdownText = markdownCandidate === "" ? undefined : markdownCandidate;
  const texts = [customText, plainText, markdownText].filter((text) => text !== undefined);
  const sizes = texts.map((text) => new TextEncoder().encode(text).byteLength);
  if (
    sizes.some((size) => size > CLIPBOARD_LIMITS.totalInputBytes) ||
    sizes.reduce((total, size) => total + size, 0) > MAX_CANDIDATE_BLOB_BYTES
  )
    return null;
  if (customText === undefined && plainText === undefined && markdownText === undefined)
    return null;
  return {
    ...(customText === undefined ? {} : { customText }),
    ...(plainText === undefined ? {} : { plainText }),
    ...(markdownText === undefined ? {} : { markdownText }),
  };
}

export async function readClipboardCandidates(
  clipboard: Clipboard | undefined,
  sessionText?: string,
  preferSession = false,
): Promise<TextClipboardCandidates | null> {
  if (preferSession) return sessionCandidates(sessionText);
  if (clipboard === undefined) return sessionCandidates(sessionText);
  try {
    const candidates = await readCandidateBlobs(clipboard);
    return materializeCandidates(candidates);
  } catch (error) {
    if (error instanceof ClipboardCandidateLimitError) return null;
    return sessionCandidates(sessionText);
  }
}

async function readCandidateBlobs(clipboard: Clipboard): Promise<readonly CandidateBlob[]> {
  if (typeof clipboard.read !== "function") throw new TypeError("Clipboard.read is unavailable.");
  const items = await clipboard.read();
  if (items.length > MAX_CLIPBOARD_ITEMS) {
    throw new ClipboardCandidateLimitError("Clipboard item count exceeds its limit.");
  }
  const item = items[0];
  if (item === undefined) return [];
  const candidates: CandidateBlob[] = [];
  let aggregateBytes = 0;
  for (const mime of SUPPORTED_MIME_TYPES) {
    if (!item.types.includes(mime)) continue;
    const blob = await item.getType(mime);
    if (!Number.isSafeInteger(blob.size) || blob.size > CLIPBOARD_LIMITS.totalInputBytes) {
      throw new ClipboardCandidateLimitError("A clipboard candidate exceeds its byte limit.");
    }
    aggregateBytes += blob.size;
    if (aggregateBytes > MAX_CANDIDATE_BLOB_BYTES) {
      throw new ClipboardCandidateLimitError("Aggregate clipboard candidates exceed their limit.");
    }
    candidates.push({ blob, mime });
  }
  return candidates;
}

async function materializeCandidates(
  candidates: readonly CandidateBlob[],
): Promise<TextClipboardCandidates> {
  let customText: string | undefined;
  let plainText: string | undefined;
  let markdownText: string | undefined;
  for (const candidate of candidates) {
    if (candidate.mime === INKBOOK_CLIPBOARD_WEB_MIME && customText === undefined) {
      const text = await boundedBlobText(candidate.blob);
      customText = text;
    } else if (candidate.mime === "text/markdown" && markdownText === undefined) {
      const text = await boundedBlobText(candidate.blob);
      if (text !== "") markdownText = text;
    } else if (candidate.mime === "text/plain" && plainText === undefined) {
      const text = await boundedBlobText(candidate.blob);
      if (text !== "") plainText = text;
    }
  }
  return {
    ...(customText === undefined ? {} : { customText }),
    ...(plainText === undefined ? {} : { plainText }),
    ...(markdownText === undefined ? {} : { markdownText }),
  };
}

async function boundedBlobText(blob: Blob): Promise<string> {
  const text = await blob.text();
  if (new TextEncoder().encode(text).byteLength > CLIPBOARD_LIMITS.totalInputBytes) {
    throw new ClipboardCandidateLimitError("Decoded clipboard text exceeds its byte limit.");
  }
  return text;
}

function sessionCandidates(sessionText?: string): ClipboardCandidates | null {
  return sessionText === undefined ? null : { sessionText };
}

export function hasInkbookClipboardCandidate(candidates: TextClipboardCandidates): boolean {
  return (
    candidates.customText !== undefined ||
    candidates.sessionText !== undefined ||
    candidates.plainText?.startsWith(INKBOOK_CLIPBOARD_TEXT_PREFIX) === true ||
    candidates.markdownText?.startsWith(INKBOOK_CLIPBOARD_TEXT_PREFIX) === true
  );
}

export function ordinaryClipboardSource(candidates: TextClipboardCandidates): string | null {
  if (hasInkbookClipboardCandidate(candidates)) return null;
  const source = candidates.markdownText ?? candidates.plainText;
  return source !== undefined &&
    source.length > 0 &&
    source.length <= MAX_TEXT_SOURCE_LENGTH &&
    !source.includes("\u0000")
    ? source
    : null;
}
