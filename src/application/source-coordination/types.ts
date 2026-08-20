import type {
  SourceCheckpointId,
  SessionOrder,
  SourceGeneration,
  Sha256Digest,
} from "../note-session/types";
import type { SidecarBaseIdentityV1 } from "../recovery/base";

export interface SourceOffsetSpanV1 {
  readonly oldFromUtf16: number;
  readonly oldToUtf16: number;
  readonly newFromUtf16: number;
  readonly newToUtf16: number;
}

export interface SourceOffsetMapV1 {
  readonly spans: readonly SourceOffsetSpanV1[];
}

export interface SourceCheckpointOperationV1 {
  readonly checkpointId: SourceCheckpointId;
  readonly sessionOrder: SessionOrder;
  readonly priorGeneration: SourceGeneration;
  readonly replacementGeneration: SourceGeneration;
  readonly priorDigest: Sha256Digest;
  readonly replacementDigest: Sha256Digest;
  readonly priorUtf16Length: number;
  readonly replacementUtf16Length: number;
  readonly offsetMap: SourceOffsetMapV1;
  readonly base: SidecarBaseIdentityV1;
}
