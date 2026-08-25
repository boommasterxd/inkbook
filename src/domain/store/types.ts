import type { RenderBand } from "../commands/render-bands";
import type { InkElementV1, InkSnapshotV1, PageV1 } from "../schema/public";
import type { SpatialBounds } from "../spatial/index";

type ElementId = string;

export interface ElementRank {
  band: RenderBand;
  rank: number;
}

export type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type ImmutableInkElement = DeepReadonly<InkElementV1>;

export interface ElementRecord {
  readonly bounds: Readonly<SpatialBounds>;
  readonly element: ImmutableInkElement;
  readonly geometryVersion: number;
  readonly paintVersion: number;
}

export const DELTA_DOMAINS = ["geometry", "paint", "order", "connection", "visibility"] as const;

export type DeltaDomain = (typeof DELTA_DOMAINS)[number];

interface ElementDelta {
  readonly after: ElementRecord | null;
  readonly before: ElementRecord | null;
  readonly domains: readonly DeltaDomain[];
  readonly id: ElementId;
}

export interface StoreDelta {
  readonly changes: readonly ElementDelta[];
  readonly dirtyBands: Readonly<{ highlight: boolean; content: boolean }>;
  readonly geometryVersion: number;
  readonly paintVersion: number;
}

export interface EndpointReference {
  readonly endpoint: "start" | "end";
  readonly linearId: ElementId;
}

export interface ElementStoreInstrumentation {
  readonly anchorBuilds: number;
  readonly anchorCacheBytes: number;
  readonly anchorCacheEntries: number;
  readonly anchorCacheEvictions: number;
  readonly anchorCacheHits: number;
  readonly bandScans: number;
  readonly deltaEntries: number;
  readonly estimatedRetainedBytes: number;
  readonly fullStoreScans: number;
  readonly hydrationElementVisits: number;
  readonly hydrationYields: number;
  readonly identityChecks: number;
  readonly identityMatches: number;
  readonly publishedDeltas: number;
  readonly recordReplacements: number;
  readonly reverseDependencyVisits: number;
  readonly snapshotMaterializations: number;
  readonly timeSlicedIndexVisits: number;
  readonly timeSlicedReplacementYields: number;
}

export interface ElementStoreMemoryUsage {
  readonly anchorCacheBytes: number;
  readonly modelBytes: number;
}

export interface StoreSliceScheduler {
  readonly isCancelled?: () => boolean;
  readonly shouldYield: () => boolean;
  readonly yieldControl: () => Promise<void>;
}

export interface TimeSlicedStoreResult {
  readonly delta: StoreDelta | null;
  readonly status: "cancelled" | "committed" | "noop";
}

declare const PREPARED_ELEMENT_REPLACEMENT: unique symbol;

export interface PreparedElementReplacement {
  readonly [PREPARED_ELEMENT_REPLACEMENT]: true;
}

export interface PreparedElementReplacementResult {
  readonly status: "cancelled" | "noop" | "prepared";
  readonly token: PreparedElementReplacement | null;
}

export interface ElementMutation {
  readonly bands: Readonly<Record<RenderBand, readonly string[]>>;
  readonly elements?: readonly InkElementV1[];
  readonly removeIds?: readonly string[];
}

export interface AppliedElementMutation {
  readonly forward: ElementMutation;
  readonly payloadBytes: number;
  readonly reverse: ElementMutation;
}

declare const PREPARED_ELEMENT_MUTATION: unique symbol;

export interface PreparedElementMutation {
  readonly [PREPARED_ELEMENT_MUTATION]: true;
}

export interface PreparedElementMutationResult {
  readonly status: "cancelled" | "noop" | "prepared";
  readonly token: PreparedElementMutation | null;
}

export interface ElementMutationCommitResult extends TimeSlicedStoreResult {
  readonly transition: AppliedElementMutation | null;
}

export interface AppliedRemovalResult {
  readonly delta: StoreDelta;
  readonly transition: AppliedElementMutation;
}

export interface CreateOptions {
  readonly placement?: "back" | "front";
}

export interface SnapshotMaterialization {
  readonly page: PageV1;
  readonly revision: number;
}

export type MaterializedSnapshot = InkSnapshotV1;
export type StoreDeltaListener = (delta: StoreDelta) => void;
export type ElementStyle = InkElementV1["style"];
