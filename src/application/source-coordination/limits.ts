import { commandFailure, commandSuccess } from "../note-session/results";
import type { CommandResultV1, Sha256Digest } from "../note-session/types";
import { parseSha256Digest } from "../note-session/value-objects";
import type {
  SourceSnapshotV1,
  StreamingSha256PortV1,
  StreamingSha256SinkV1,
} from "./types";
import type {
  SourceDigestWorkPortV1,
  SourceDigestWorkSubmissionV1,
} from "./work-ports";

const KIBIBYTE = 1024;
const MEBIBYTE = KIBIBYTE * KIBIBYTE;
const UTF16_BYTES_PER_CODE_UNIT = 2;
const ASCII_TWO_BYTE_BOUNDARY = 0x80;
const UTF8_THREE_BYTE_BOUNDARY = 0x800;
const UTF8_TWO_BYTES = 2;
const UTF8_THREE_BYTES = 3;
const UTF8_FOUR_BYTES = 4;
const LINE_FEED = 0x0a;
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;
const UTF8_SOURCE_CHUNK_UTF16 = 65_536;
const DIGEST_WORKER_ADMISSION_KIB = 512;

export const SOURCE_COORDINATION_LIMITS_V1 = Object.freeze({
  maxChangedSpans: 65_536,
  // eslint-disable-next-line @typescript-eslint/no-magic-numbers
  maxEncodedOffsetMapBytes: 4 * MEBIBYTE,
  maxHistoryMappingNodes: 32,
  // eslint-disable-next-line @typescript-eslint/no-magic-numbers
  maxMappingCompactionScratchBytes: 8 * MEBIBYTE,
  // eslint-disable-next-line @typescript-eslint/no-magic-numbers
  maxMarkdownUtf16Length: 8 * MEBIBYTE,
  // eslint-disable-next-line @typescript-eslint/no-magic-numbers
  maxMarkdownUtf8Bytes: 16 * MEBIBYTE,
  // eslint-disable-next-line @typescript-eslint/no-magic-numbers
  maxRetainedSourceBytes: 48 * MEBIBYTE,
  maxSourceBlockUtf16Length: 1_048_576,
  maxSourceBlocks: 65_536,
  // eslint-disable-next-line @typescript-eslint/no-magic-numbers
  maxStreamingDigestChunkBytes: 256 * KIBIBYTE,
  sourceDigestWorkerAdmissionBytes: DIGEST_WORKER_ADMISSION_KIB * KIBIBYTE,
});

export interface SourceSnapshotAdmissionV1 {
  readonly maxSourceBlockUtf16Length: number;
  readonly retainedBytes: number;
  readonly sourceBlockCount: number;
  readonly utf16Length: number;
  readonly utf8Bytes: number;
}

export function preflightSourceSnapshot(
  markdown: string,
): CommandResultV1<SourceSnapshotAdmissionV1> {
  if (markdown.length > SOURCE_COORDINATION_LIMITS_V1.maxMarkdownUtf16Length) {
    return commandFailure("resource-limit");
  }
  const utf8Bytes = boundedUtf8ByteLength(markdown);
  if (utf8Bytes === null) return commandFailure("resource-limit");
  const blocks = inspectSourceBlocks(markdown);
  if (blocks === null) return commandFailure("resource-limit");
  return commandSuccess(
    Object.freeze({
      maxSourceBlockUtf16Length: blocks.maximumLength,
      retainedBytes: markdown.length * UTF16_BYTES_PER_CODE_UNIT,
      sourceBlockCount: blocks.count,
      utf16Length: markdown.length,
      utf8Bytes,
    }),
  );
}

export function createSourceSnapshot(
  markdown: string,
): CommandResultV1<SourceSnapshotV1> {
  const admission = preflightSourceSnapshot(markdown);
  if (!admission.ok) return admission;
  return commandSuccess(
    Object.freeze({
      markdown,
      retainedBytes: admission.value.retainedBytes,
      utf16Length: admission.value.utf16Length,
      utf8Bytes: admission.value.utf8Bytes,
    }),
  );
}

export async function digestMarkdownSnapshot(
  port: StreamingSha256PortV1,
  snapshot: SourceSnapshotV1,
  workPort?: SourceDigestWorkPortV1,
  signal?: AbortSignal,
): Promise<CommandResultV1<Sha256Digest>> {
  if (
    workPort !== undefined &&
    snapshot.utf8Bytes >=
      SOURCE_COORDINATION_LIMITS_V1.sourceDigestWorkerAdmissionBytes
  ) {
    return digestMarkdownSnapshotWithWorkPort(workPort, snapshot, signal);
  }
  const sink = createDigestSink(port);
  if (sink === null) return commandFailure("recovery-unavailable");
  const encoder = new TextEncoder();
  try {
    await streamMarkdownDigestChunks(snapshot, encoder, (chunk) =>
      sink.update(chunk),
    );
    return commandSuccess(parseSha256Digest(await sink.finish()));
  } catch {
    return commandFailure("recovery-unavailable");
  } finally {
    sink.dispose?.();
  }
}

async function digestMarkdownSnapshotWithWorkPort(
  port: SourceDigestWorkPortV1,
  snapshot: SourceSnapshotV1,
  signal?: AbortSignal,
): Promise<CommandResultV1<Sha256Digest>> {
  let submission: SourceDigestWorkSubmissionV1;
  try {
    submission = port.submit();
  } catch {
    return commandFailure("recovery-unavailable");
  }
  const cancel = (): void => {
    try {
      submission.cancel();
    } catch {
      // Cancellation still closes source ownership when transport cleanup fails.
    }
  };
  if (signal?.aborted === true) {
    cancel();
    return commandFailure("disposed");
  }
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const encoder = new TextEncoder();
    await streamMarkdownDigestChunks(snapshot, encoder, async (chunk) => {
      if (isAborted(signal)) throw new Error("Digest work was cancelled.");
      await submission.update(chunk);
    });
    if (isAborted(signal)) return commandFailure("disposed");
    submission.closeInput();
    const result = await submission.completion;
    if (isAborted(signal)) return commandFailure("disposed");
    return result.ok ? commandSuccess(parseSha256Digest(result.value)) : result;
  } catch {
    cancel();
    return commandFailure(
      isAborted(signal) ? "disposed" : "recovery-unavailable",
    );
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

async function streamMarkdownDigestChunks(
  snapshot: SourceSnapshotV1,
  encoder: TextEncoder,
  update: (chunk: Uint8Array) => void | Promise<void>,
): Promise<void> {
  let offset = 0;
  while (offset < snapshot.markdown.length) {
    let end = Math.min(
      offset + UTF8_SOURCE_CHUNK_UTF16,
      snapshot.markdown.length,
    );
    if (
      end < snapshot.markdown.length &&
      isHighSurrogate(snapshot.markdown.charCodeAt(end - 1)) &&
      isLowSurrogateAt(snapshot.markdown, end)
    ) {
      end -= 1;
    }
    await update(encoder.encode(snapshot.markdown.slice(offset, end)));
    offset = end;
  }
}

function createDigestSink(
  port: StreamingSha256PortV1,
): StreamingSha256SinkV1 | null {
  try {
    return port.create();
  } catch {
    return null;
  }
}

function boundedUtf8ByteLength(markdown: string): number | null {
  let bytes = 0;
  for (let index = 0; index < markdown.length; index += 1) {
    const codeUnit = markdown.charCodeAt(index);
    if (codeUnit < ASCII_TWO_BYTE_BOUNDARY) bytes += 1;
    else if (codeUnit < UTF8_THREE_BYTE_BOUNDARY) bytes += UTF8_TWO_BYTES;
    else if (
      isHighSurrogate(codeUnit) &&
      isLowSurrogateAt(markdown, index + 1)
    ) {
      bytes += UTF8_FOUR_BYTES;
      index += 1;
    } else bytes += UTF8_THREE_BYTES;
    if (bytes > SOURCE_COORDINATION_LIMITS_V1.maxMarkdownUtf8Bytes) {
      return null;
    }
  }
  return bytes;
}

function inspectSourceBlocks(
  markdown: string,
): { readonly count: number; readonly maximumLength: number } | null {
  if (markdown.length === 0)
    return Object.freeze({ count: 1, maximumLength: 0 });
  let blockStart = 0;
  let count = 0;
  let maximumLength = 0;
  let cursor = 0;
  while (cursor <= markdown.length) {
    if (!isBlankLineBoundary(markdown, cursor)) {
      cursor += 1;
      continue;
    }
    const blockEnd = consumeLineEnding(markdown, cursor);
    const blockLength = blockEnd - blockStart;
    count += 1;
    maximumLength = Math.max(maximumLength, blockLength);
    if (
      count > SOURCE_COORDINATION_LIMITS_V1.maxSourceBlocks ||
      maximumLength > SOURCE_COORDINATION_LIMITS_V1.maxSourceBlockUtf16Length
    ) {
      return null;
    }
    blockStart = blockEnd;
    cursor = blockEnd;
  }
  if (blockStart < markdown.length) {
    count += 1;
    maximumLength = Math.max(maximumLength, markdown.length - blockStart);
  }
  if (
    count > SOURCE_COORDINATION_LIMITS_V1.maxSourceBlocks ||
    maximumLength > SOURCE_COORDINATION_LIMITS_V1.maxSourceBlockUtf16Length
  ) {
    return null;
  }
  return Object.freeze({ count, maximumLength });
}

function isBlankLineBoundary(markdown: string, cursor: number): boolean {
  if (cursor >= markdown.length || markdown.charCodeAt(cursor) !== LINE_FEED) {
    return false;
  }
  const next = cursor + 1;
  return next >= markdown.length || markdown.charCodeAt(next) === LINE_FEED;
}

function consumeLineEnding(markdown: string, cursor: number): number {
  let end = cursor + 1;
  while (end < markdown.length && markdown.charCodeAt(end) === LINE_FEED) {
    end += 1;
  }
  return end;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= HIGH_SURROGATE_MIN && codeUnit <= HIGH_SURROGATE_MAX;
}

function isLowSurrogateAt(markdown: string, index: number): boolean {
  const codeUnit = markdown.charCodeAt(index);
  return codeUnit >= LOW_SURROGATE_MIN && codeUnit <= LOW_SURROGATE_MAX;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
