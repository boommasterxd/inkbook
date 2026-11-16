import type { MessageKey } from "../../domain/localization";
import { ImageHeaderError } from "../../persistence/images/image-header";

const messages = {
  sourceSize: "images.failureSourceSize",
  sourceRead: "images.failureSourceRead",
  dimensions: "images.failureDimensions",
  decode: "images.failureDecode",
  encodedSize: "images.failureEncodedSize",
  pdfPages: "images.failurePages",
  documentCapacity: "images.failureCapacity",
} as const satisfies Readonly<Record<string, MessageKey>>;

/** Identifies expected admission failures without exposing native exception text. */
export class ImageImportError extends RangeError {
  public constructor(
    public readonly reason: keyof typeof messages,
    message: string,
  ) {
    super(message);
  }
}

export function imageImportErrorMessage(error: unknown): MessageKey {
  if (error instanceof ImageImportError) return messages[error.reason];
  if (error instanceof ImageHeaderError)
    return error.reason === "dimensions" ? "images.failureDimensions" : "images.failureFormat";
  return "images.failure";
}
