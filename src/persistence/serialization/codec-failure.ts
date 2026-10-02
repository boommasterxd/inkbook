import type { ValidationError } from "../../domain/schema/public";
import type { DocumentCodecError, DocumentCodecErrorCode, DocumentCodecResult } from "./types";

export function invalidSnapshot(error: ValidationError): DocumentCodecResult<never> {
  return {
    error: {
      code: "snapshot-invalid",
      message: "Snapshot validation failed.",
      validationError: error,
    },
    ok: false,
  };
}

export function codecFailure<T>(
  code: DocumentCodecErrorCode,
  message: string,
): DocumentCodecResult<T> {
  const error: DocumentCodecError = { code, message };
  return { error, ok: false };
}

export function generatedOutputLimitFailure(): DocumentCodecResult<never> {
  return codecFailure("static-output-limit-exceeded", "Generated document exceeds file limits.");
}
