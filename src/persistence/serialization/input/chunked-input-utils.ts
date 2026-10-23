import type { ValidationError } from "../../../domain/schema/public";
import type { DocumentCodecError, DocumentCodecErrorCode, DocumentCodecResult } from "../types";

export function combineInputBytes(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export function positiveInputInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}
export function inputFailure<T>(
  code: DocumentCodecErrorCode,
  message: string,
  validationError?: ValidationError,
): DocumentCodecResult<T> {
  const error: DocumentCodecError =
    validationError === undefined ? { code, message } : { code, message, validationError };
  return { error, ok: false };
}
