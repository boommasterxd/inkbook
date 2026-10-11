import type { PreparedSpatialReplacements, UniformSpatialIndex } from "../spatial/index";

import type { DocumentCapacity, DocumentCapacityPatch } from "./document-capacity";
import type { ReverseConnectionPatch } from "./replacement-reverse-patch";
import type { ReplacementHistory } from "./replacement-history";
import type {
  ElementRecord,
  ElementReplacementHistoryData,
  EndpointReference,
  StoreDelta,
} from "./types";

export interface ElementReplacementPlan {
  readonly history: ElementReplacementHistoryData;
  readonly capacityPatch: DocumentCapacityPatch;
  readonly delta: StoreDelta;
  readonly geometryVersion: number;
  readonly indexPatch: PreparedSpatialReplacements<string>;
  readonly indexVisitCount: number;
  readonly paintVersion: number;
  readonly records: readonly ElementRecord[];
  readonly replacementCount: number;
  readonly reversePatches: readonly ReverseConnectionPatch[];
  readonly yields: number;
}

export interface PreparedReplacementRecords {
  readonly history: ElementReplacementHistoryData;
  readonly capacityPreviousRecords: ElementRecord[];
  readonly capacityRecords: ElementRecord[];
  readonly changes: Array<StoreDelta["changes"][number]>;
  readonly records: ElementRecord[];
  readonly spatialReplacements: Array<{ bounds: ElementRecord["bounds"]; id: string }>;
  readonly yields: number;
}

export interface ElementReplacementSource {
  readonly history: ReplacementHistory;
  readonly capacity: DocumentCapacity;
  readonly geometryVersion: number;
  readonly paintVersion: number;
  readonly records: ReadonlyMap<string, ElementRecord>;
  readonly reverseConnections: ReadonlyMap<string, readonly EndpointReference[]>;
  readonly spatialIndex: UniformSpatialIndex<string>;
}

export interface PreparedReplacementState {
  readonly isCancelled: () => boolean;
  readonly mutationVersion: number;
  readonly plan: ElementReplacementPlan;
}
