import type { RenderBand } from "../commands/render-bands";
import type { PreparedSpatialInsertions, UniformSpatialIndex } from "../spatial/index";
import type { DocumentCapacity, DocumentCapacityPatch } from "./document-capacity";
import type { MutationSource } from "./element-mutation";
import type { ElementStoreOrdering } from "./order-operations";
import type { ReverseConnectionPatch } from "./replacement-reverse-patch";
import type { AppliedElementMutation, ElementPlacement, ElementRank, ElementRecord, StoreDelta } from "./types";

export interface CompactMutationSource extends MutationSource {
  readonly capacity: DocumentCapacity;
  readonly index: UniformSpatialIndex<string>;
  readonly getRank: (id: string) => ElementRank | undefined;
  readonly sizeOfBand: (band: RenderBand) => number;
}

export interface CompactMutationPlan {
  readonly kind: "compact";
  readonly applied: AppliedElementMutation;
  readonly capacityPatch: DocumentCapacityPatch;
  readonly delta: StoreDelta;
  readonly insertions: PreparedSpatialInsertions<string>;
  readonly placements: readonly ElementPlacement[];
  readonly reversePatches: readonly ReverseConnectionPatch[];
}

export interface CompactCommitState {
  readonly capacity: DocumentCapacity;
  readonly index: UniformSpatialIndex<string>;
  readonly ordering: ElementStoreOrdering;
  readonly records: Map<string, ElementRecord>;
  readonly reverseConnections: Map<string, import("./types").EndpointReference[]>;
}
