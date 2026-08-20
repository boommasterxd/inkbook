import { commandFailure, commandSuccess } from "../note-session/results";
import type { CommandResultV1, Sha256Digest } from "../note-session/types";
import { createStreamingSha256PortV1 } from "./sha256-port";
import { SOURCE_COORDINATION_LIMITS_V1 } from "./limits";
import type {
  ImmutableSourceDocumentV1,
  SourceSnapshotV1,
  StreamingSha256SinkV1,
} from "./types";
import type { SourceDigestWorkPortV1 } from "./work-ports";
import { createSourceDigestStreamingSha256PortV1 } from "./sha256-port";

const SOURCE_CHUNK_UTF16 = 65_536;
const UTF16_BYTES_PER_CODE_UNIT = 2;
const LINE_FEED = 0x0a;
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;
const BLANK_LINE_FEED_COUNT = 2;
const SURROGATE_PAIR_LENGTH = 2;

interface ImmutableSourceDocumentAdmissionV1 {
  readonly utf8Bytes: number;
}

export function immutableSourceDocumentRetainedBytesV1(
  document: ImmutableSourceDocumentV1,
): number {
  return document.utf16Length * UTF16_BYTES_PER_CODE_UNIT;
}

export function preflightImmutableSourceDocumentV1(
  document: ImmutableSourceDocumentV1,
): CommandResultV1<ImmutableSourceDocumentAdmissionV1> {
  if (
    !Number.isSafeInteger(document.utf16Length) ||
    document.utf16Length < 0 ||
    document.utf16Length > SOURCE_COORDINATION_LIMITS_V1.maxMarkdownUtf16Length
  ) {
    return commandFailure("resource-limit");
  }
  const encoder = new TextEncoder();
  let utf8Bytes = 0;
  let blockLength = 0;
  let blockCount = 0;
  let lineFeedRun = 0;
  try {
    forEachDocumentChunkSync(document, (chunk) => {
      utf8Bytes += encoder.encode(chunk).byteLength;
      if (utf8Bytes > SOURCE_COORDINATION_LIMITS_V1.maxMarkdownUtf8Bytes) {
        throw new SourceDocumentLimitError();
      }
      for (let index = 0; index < chunk.length; index += 1) {
        const codeUnit = chunk.charCodeAt(index);
        if (codeUnit !== LINE_FEED && lineFeedRun >= BLANK_LINE_FEED_COUNT) {
          blockCount += 1;
          assertBlockLimits(blockCount, blockLength);
          blockLength = 0;
          lineFeedRun = 0;
        }
        blockLength += 1;
        lineFeedRun = codeUnit === LINE_FEED ? lineFeedRun + 1 : 0;
      }
    });
    if (document.utf16Length === 0) {
      blockCount = 1;
    } else if (lineFeedRun > 0 || blockLength > 0) {
      blockCount += 1;
      assertBlockLimits(blockCount, blockLength);
    }
  } catch {
    return commandFailure("resource-limit");
  }
  return commandSuccess(Object.freeze({ utf8Bytes }));
}

export async function digestImmutableSourceDocumentV1(
  document: ImmutableSourceDocumentV1,
  workPort: SourceDigestWorkPortV1,
  signal?: AbortSignal,
): Promise<CommandResultV1<Sha256Digest>> {
  const admission = preflightImmutableSourceDocumentV1(document);
  if (!admission.ok) return admission;
  if (isAborted(signal)) return commandFailure("disposed");
  const streaming =
    admission.value.utf8Bytes >=
    SOURCE_COORDINATION_LIMITS_V1.sourceDigestWorkerAdmissionBytes
      ? createSourceDigestStreamingSha256PortV1(workPort)
      : createStreamingSha256PortV1();
  let sink: StreamingSha256SinkV1 | null = null;
  try {
    sink = streaming.create();
    const encoder = new TextEncoder();
    await forEachDocumentChunkAsync(document, async (chunk) => {
      if (isAborted(signal)) throw new SourceDocumentAbortError();
      await sink?.update(encoder.encode(chunk));
    });
    if (isAborted(signal)) return commandFailure("disposed");
    return commandSuccess(await sink.finish());
  } catch (error) {
    return commandFailure(
      error instanceof SourceDocumentAbortError
        ? "disposed"
        : "recovery-unavailable",
    );
  } finally {
    sink?.dispose?.();
  }
}

export function materializeImmutableSourceDocumentV1(
  document: ImmutableSourceDocumentV1,
): CommandResultV1<SourceSnapshotV1> {
  const admission = preflightImmutableSourceDocumentV1(document);
  if (!admission.ok) return admission;
  try {
    const markdown = document.sliceString(0, document.utf16Length);
    if (markdown.length !== document.utf16Length) {
      return commandFailure("stale-source");
    }
    return commandSuccess(
      Object.freeze({
        markdown,
        retainedBytes: immutableSourceDocumentRetainedBytesV1(document),
        utf16Length: document.utf16Length,
        utf8Bytes: admission.value.utf8Bytes,
      }),
    );
  } catch {
    return commandFailure("stale-source");
  }
}

async function forEachDocumentChunkAsync(
  document: ImmutableSourceDocumentV1,
  consume: (chunk: string) => Promise<void>,
): Promise<void> {
  let offset = 0;
  while (offset < document.utf16Length) {
    const range = nextDocumentChunk(document, offset);
    await consume(range.chunk);
    offset = range.end;
  }
}

function forEachDocumentChunkSync(
  document: ImmutableSourceDocumentV1,
  consume: (chunk: string) => void,
): void {
  let offset = 0;
  while (offset < document.utf16Length) {
    const range = nextDocumentChunk(document, offset);
    consume(range.chunk);
    offset = range.end;
  }
}

function nextDocumentChunk(
  document: ImmutableSourceDocumentV1,
  offset: number,
): { readonly chunk: string; readonly end: number } {
  let end = Math.min(offset + SOURCE_CHUNK_UTF16, document.utf16Length);
  if (end < document.utf16Length) {
    const edge = document.sliceString(end - 1, end + 1);
    if (isSurrogatePair(edge)) end -= 1;
  }
  const chunk = document.sliceString(offset, end);
  if (chunk.length !== end - offset) throw new SourceDocumentLimitError();
  return Object.freeze({ chunk, end });
}

function assertBlockLimits(count: number, length: number): void {
  if (
    count > SOURCE_COORDINATION_LIMITS_V1.maxSourceBlocks ||
    length > SOURCE_COORDINATION_LIMITS_V1.maxSourceBlockUtf16Length
  ) {
    throw new SourceDocumentLimitError();
  }
}

function isSurrogatePair(value: string): boolean {
  if (value.length !== SURROGATE_PAIR_LENGTH) return false;
  const high = value.charCodeAt(0);
  const low = value.charCodeAt(1);
  return (
    high >= HIGH_SURROGATE_MIN &&
    high <= HIGH_SURROGATE_MAX &&
    low >= LOW_SURROGATE_MIN &&
    low <= LOW_SURROGATE_MAX
  );
}

class SourceDocumentLimitError extends Error {}
class SourceDocumentAbortError extends Error {}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
