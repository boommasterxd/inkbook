import type { InkElementV1, PointV1, BoxAnchorV1 } from "../../domain/schema/public";
import type {
  SnapCandidate,
  SnapLookupInput,
  SnapTargetReader,
  SpatialCandidateQuery,
} from "../snapping/snap-candidate";

import type { SelectionReplacementPlanner } from "./selection-work-budget";

export type SelectionHandleAction =
  | { readonly kind: "move" }
  | { readonly anchor: PointV1; readonly kind: "scale"; readonly position: BoxAnchorV1 }
  | { readonly center: PointV1; readonly kind: "rotate" }
  | {
      readonly elementId: string;
      readonly endpoint: "start" | "end";
      readonly kind: "linear-endpoint";
    }
  | { readonly elementId: string; readonly kind: "linear-bend" }
  | { readonly axisIndex: number; readonly elementId: string; readonly kind: "coordinate-axis" }
  | { readonly elementId: string; readonly kind: "coordinate-origin" };

export type SelectionPreviewTransform =
  | { readonly delta: PointV1; readonly kind: "translate" }
  | {
      readonly anchor: PointV1;
      readonly factors: { readonly x: number; readonly y: number };
      readonly kind: "scale";
      readonly rotation: number;
    }
  | {
      readonly center: PointV1;
      readonly degrees: number;
      readonly kind: "rotate";
    };

export interface SelectionHandlePreview {
  readonly exactElements: readonly InkElementV1[];
  readonly exactPreviewTruncated: boolean;
  readonly snapCandidate: SnapCandidate | null;
  readonly snapGuide: SelectionSnapGuide | null;
  readonly transform: SelectionPreviewTransform | null;
}

export type SelectionSnapGuide =
  | { readonly kind: "anchor"; readonly point: PointV1 }
  | {
      readonly center: PointV1;
      readonly handle: PointV1;
      readonly kind: "rotation";
    }
  | {
      readonly alignment: "straight" | "symmetric";
      readonly curvePoint: PointV1;
      readonly end: PointV1;
      readonly kind: "bend";
      readonly start: PointV1;
    };

export interface SelectionSnapPorts {
  readonly pointerType: SnapLookupInput["pointerType"];
  readonly spatial: SpatialCandidateQuery;
  readonly targets: SnapTargetReader;
  readonly zoom: number;
}

export interface SelectionHandleSessionOptions {
  readonly action: SelectionHandleAction;
  readonly elements: readonly InkElementV1[];
  readonly planner: SelectionReplacementPlanner;
  readonly snap?: SelectionSnapPorts;
  readonly startPointer: PointV1;
}

export type SelectionCommitPreparation =
  | { readonly status: "noop" }
  | { readonly status: "time-sliced-required" }
  | {
      readonly previous: readonly InkElementV1[];
      readonly replacements: readonly InkElementV1[];
      readonly status: "ready";
    };

export type TimeSlicedSelectionCommitPreparation =
  | { readonly status: "cancelled" | "noop" }
  | Extract<SelectionCommitPreparation, { status: "ready" }>;
