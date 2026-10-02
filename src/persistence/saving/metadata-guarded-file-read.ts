import type { FileReadIdentity, MetadataGuardedFileRead } from "./save-ports";

/** Stable host evidence. Exact UTF-8 size remains unverified until save verification. */
export class MetadataGuardedFileReadCandidate implements MetadataGuardedFileRead {
  readonly #owned = true;
  public readonly identity: FileReadIdentity;
  public readonly materialization = "host-full-read-not-bounded" as const;
  public readonly stabilityEvidence = "object-identity-and-stat-unchanged" as const;

  public constructor(
    public readonly content: string,
    identity: FileReadIdentity,
    public readonly isCurrent: () => boolean,
  ) {
    this.identity = Object.freeze({ ...identity });
    Object.freeze(this);
  }

  public static isOwned(read: MetadataGuardedFileRead): read is MetadataGuardedFileReadCandidate {
    return #owned in read;
  }
}
