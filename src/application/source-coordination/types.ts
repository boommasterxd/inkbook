import type {
  CommandErrorCodeV1,
  HostTransactionSequence,
  SourceCheckpointId,
  SessionOrder,
  SourceGeneration,
  Sha256Digest,
  ViewId,
} from "../note-session/types";
import type { SidecarBaseIdentityV1 } from "../recovery/base";

export interface SourceSnapshotV1 {
  readonly markdown: string;
  readonly retainedBytes: number;
  readonly utf16Length: number;
  readonly utf8Bytes: number;
}

export interface ImmutableSourceDocumentV1 {
  readonly utf16Length: number;
  sliceString(fromUtf16: number, toUtf16: number): string;
}

export interface SourceOffsetSpanV1 {
  readonly oldFromUtf16: number;
  readonly oldToUtf16: number;
  readonly newFromUtf16: number;
  readonly newToUtf16: number;
}

export interface SourceOffsetMapV1 {
  readonly spans: readonly SourceOffsetSpanV1[];
}

export interface SourceOffsetMapIdentityV1 {
  readonly digest: Sha256Digest;
  readonly encodedBytes: number;
  readonly offsetMap: SourceOffsetMapV1;
  readonly priorUtf16Length: number;
  readonly replacementUtf16Length: number;
}

export interface StreamingSha256SinkV1 {
  update(chunk: Uint8Array): void | Promise<void>;
  finish(): Promise<Sha256Digest>;
  dispose?(): void;
}

export interface StreamingSha256PortV1 {
  create(): StreamingSha256SinkV1;
}

export interface MarkdownSourceTransitionV1 {
  readonly hostTransactionSequence: HostTransactionSequence;
  readonly offsetMap: SourceOffsetMapV1;
  readonly offsetMapDigest?: Sha256Digest;
  readonly ownedMetadataChange: boolean;
  readonly priorDigest: Sha256Digest;
  readonly priorGeneration: SourceGeneration;
  readonly replacementMarkdown: string;
  readonly viewId: ViewId;
}

export interface SourceAdmissionV1 {
  readonly digest: Sha256Digest;
  readonly generation: SourceGeneration;
  readonly kind: "admitted" | "duplicate";
  readonly mapDigest: Sha256Digest;
  readonly snapshot: SourceSnapshotV1;
}

export type MarkdownSourceStateV1 =
  | {
      readonly digest: Sha256Digest;
      readonly generation: SourceGeneration;
      readonly kind: "durable";
    }
  | {
      readonly durableGeneration: SourceGeneration;
      readonly failure: CommandErrorCodeV1 | null;
      readonly generation: SourceGeneration;
      readonly kind: "checkpoint-pending";
    }
  | {
      readonly failure: CommandErrorCodeV1;
      readonly kind: "reattaching";
      readonly targetDigest: Sha256Digest;
    };

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
