import { utf8ByteLengthWithinLimit } from "../scheduling/utf8-byte-length";
import type { FileReadIdentity, MetadataGuardedFileRead } from "./save-ports";

/** Immutable proof that exact text bytes matched a stable host file identity. */
export class VerifiedMetadataGuardedFileRead implements MetadataGuardedFileRead {
  readonly #verified = true;
  public readonly content: string;
  public readonly identity: FileReadIdentity;
  public readonly materialization = "host-full-read-not-bounded" as const;
  public readonly stabilityEvidence = "object-identity-and-stat-unchanged" as const;
  public readonly isCurrent?: () => boolean;

  private constructor(content: string, identity: FileReadIdentity, isCurrent?: () => boolean) {
    this.content = content;
    this.identity = Object.freeze({ ...identity });
    if (isCurrent !== undefined) this.isCurrent = isCurrent;
    Object.freeze(this);
  }

  public static create(
    content: string,
    identity: FileReadIdentity,
    maximumBytes: number,
    isCurrent?: () => boolean,
  ): VerifiedMetadataGuardedFileRead | "too-large" | "size-mismatch" {
    const bytes = utf8ByteLengthWithinLimit(content, maximumBytes);
    if (bytes === null) return "too-large";
    if (bytes !== identity.size) return "size-mismatch";
    return new VerifiedMetadataGuardedFileRead(content, identity, isCurrent);
  }

  public static isVerified(read: MetadataGuardedFileRead): read is VerifiedMetadataGuardedFileRead {
    return #verified in read;
  }
}
