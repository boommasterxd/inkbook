import type {
  NoteIdentityV1,
  Sha256Digest,
  SourceGeneration,
} from "../../application/note-session";
import {
  sameSidecarBase,
  type FileRelocationRecordV1,
  type SidecarBaseIdentityV1,
} from "../../application/recovery";

export interface RuntimePersistenceExternalStateV1 {
  readonly activeRelocation: FileRelocationRecordV1 | null;
  readonly base: SidecarBaseIdentityV1;
  readonly identity: NoteIdentityV1;
  readonly pendingRecovery: boolean;
  readonly rawText: string | null;
  readonly sourceDigest: Sha256Digest;
  readonly sourceGeneration: SourceGeneration;
  readonly sourceUtf16Length: number;
}

export function createRuntimePersistenceExternalStateV1(input: {
  readonly activeRelocation: FileRelocationRecordV1 | null;
  readonly base: SidecarBaseIdentityV1 | null;
  readonly identity: NoteIdentityV1;
  readonly pendingRecovery: boolean;
  readonly rawText: string | null;
  readonly source:
    | Readonly<{ digest: Sha256Digest; generation: SourceGeneration }>
    | undefined;
  readonly sourceUtf16Length: number;
}): RuntimePersistenceExternalStateV1 | null {
  return input.base === null || input.source === undefined
    ? null
    : {
        activeRelocation: input.activeRelocation,
        base: input.base,
        identity: input.identity,
        pendingRecovery: input.pendingRecovery,
        rawText: input.rawText,
        sourceDigest: input.source.digest,
        sourceGeneration: input.source.generation,
        sourceUtf16Length: input.sourceUtf16Length,
      };
}

export class RuntimeOwnedSidecarWriteV1 {
  #expected: SidecarBaseIdentityV1 | null = null;

  public prepare(base: SidecarBaseIdentityV1): void {
    this.#expected = base;
  }

  public reject(base: SidecarBaseIdentityV1): void {
    if (this.#expected === base) this.#expected = null;
  }

  public consume(base: SidecarBaseIdentityV1): boolean {
    if (this.#expected === null || !sameSidecarBase(this.#expected, base)) {
      return false;
    }
    this.#expected = null;
    return true;
  }
}
