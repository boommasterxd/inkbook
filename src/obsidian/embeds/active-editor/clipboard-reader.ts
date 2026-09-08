import {
  CLIPBOARD_LIMITS,
  INKBOOK_CLIPBOARD_TEXT_PREFIX,
  INKBOOK_CLIPBOARD_WEB_MIME,
} from "../../../persistence/clipboard/constants";
import type { ClipboardCandidates } from "../../../persistence/clipboard/types";

const SUPPORTED_MIME_TYPES = [INKBOOK_CLIPBOARD_WEB_MIME, "text/plain"] as const;
const MAX_CANDIDATE_BLOB_BYTES = CLIPBOARD_LIMITS.totalInputBytes * SUPPORTED_MIME_TYPES.length;
export const MAX_CLIPBOARD_ITEMS = 256;

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
): ClipboardCandidates | null {
  if (data === null) return null;
  let customCandidate: string | undefined;
  let plainCandidate: string | undefined;
  try {
    customCandidate = data.types.includes(INKBOOK_CLIPBOARD_WEB_MIME)
      ? data.getData(INKBOOK_CLIPBOARD_WEB_MIME)
      : undefined;
    plainCandidate = data.types.includes("text/plain") ? data.getData("text/plain") : undefined;
  } catch {
    return null;
  }
  const customText = customCandidate === "" ? undefined : customCandidate;
  const plainText =
    plainCandidate !== undefined &&
    plainCandidate.length > INKBOOK_CLIPBOARD_TEXT_PREFIX.length &&
    plainCandidate.startsWith(INKBOOK_CLIPBOARD_TEXT_PREFIX)
      ? plainCandidate
      : undefined;
  if (customText === undefined && plainText === undefined) return null;
  return {
    ...(customText === undefined ? {} : { customText }),
    ...(plainText === undefined ? {} : { plainText }),
  };
}

export async function readClipboardCandidates(
  clipboard: Clipboard | undefined,
  sessionText?: string,
  preferSession = false,
): Promise<ClipboardCandidates | null> {
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
): Promise<ClipboardCandidates> {
  let customText: string | undefined;
  let plainText: string | undefined;
  for (const candidate of candidates) {
    if (candidate.mime === INKBOOK_CLIPBOARD_WEB_MIME && customText === undefined) {
      const text = await boundedBlobText(candidate.blob);
      if (text !== "") customText = text;
    } else if (candidate.mime === "text/plain" && plainText === undefined) {
      const text = await boundedBlobText(candidate.blob);
      if (text !== "") plainText = text;
    }
  }
  return {
    ...(customText === undefined ? {} : { customText }),
    ...(plainText === undefined ? {} : { plainText }),
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
