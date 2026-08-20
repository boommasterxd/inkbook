import type { Sha256Digest } from "../../application/note-session";
import { SIDECAR_RESOURCE_LIMITS_V1 } from "../../application/persistence";
import type { SourceDigestWorkPortV1 } from "../../application/source-coordination/work-ports";

const UTF16_DIGEST_CHUNK_UNITS = 65_536;
const MAX_BMP_CODE_POINT = 65_535;

interface RuntimeExternalDigestOptionsV1 {
  readonly expectedBytes: number;
  readonly rawText: string;
  readonly registerCancel: (cancel: () => void) => void;
  readonly releaseCancel: (cancel: () => void) => void;
  readonly workPort: SourceDigestWorkPortV1;
}

export async function digestRuntimeExternalTextV1(
  options: RuntimeExternalDigestOptionsV1,
): Promise<Sha256Digest | null> {
  const submission = options.workPort.submit();
  const cancel = (): void => submission.cancel();
  options.registerCancel(cancel);
  let measuredBytes = 0;
  try {
    const encoder = new TextEncoder();
    let offset = 0;
    while (offset < options.rawText.length) {
      const end = digestChunkEnd(options.rawText, offset);
      const chunk = encoder.encode(options.rawText.slice(offset, end));
      measuredBytes += chunk.byteLength;
      if (measuredBytes > SIDECAR_RESOURCE_LIMITS_V1.maxUtf8Bytes) {
        submission.cancel();
        return null;
      }
      await submission.update(chunk);
      offset = end;
    }
    submission.closeInput();
    const result = await submission.completion;
    return result.ok && measuredBytes === options.expectedBytes
      ? result.value
      : null;
  } catch {
    submission.cancel();
    return null;
  } finally {
    options.releaseCancel(cancel);
  }
}

function digestChunkEnd(rawText: string, offset: number): number {
  let end = Math.min(offset + UTF16_DIGEST_CHUNK_UNITS, rawText.length);
  if (
    end < rawText.length &&
    (rawText.codePointAt(end - 1) ?? 0) > MAX_BMP_CODE_POINT
  ) {
    end -= 1;
  }
  return end;
}
