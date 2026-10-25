import type { InkElementV1, PointV1, BoxAnchorV1 } from "../../domain/schema/public";
import type { Bounds } from "../../domain/geometry/public";
import type {
  SnapCandidate,
  SnapLookupInput,
  SnapTargetReader,
  SpatialCandidateQuery,
} from "../snapping/snap-candidate";

import type { SelectionReplacementPlanner } from "./selection-work-budget";

export interface SelectedElementGeometry {
  readonly bounds: Bounds;
  readonly element: InkElementV1;
}

export type SelectionHandleAction =
  | { readonly kind: "move" }
  | {
      readonly anchor: PointV1;
      readonly kind: "scale";
      readonly position: BoxAnchorV1;
      readonly rotation: number;
    }
  | {
      readonly center: PointV1;
      readonly kind: "rotate";
      readonly opposite: PointV1;
      readonly referenceRotation: number;
    }
  | {
      readonly elementId: string;
      readonly endpoint: "start" | "end";
      readonly kind: "linear-endpoint";
    }
  | { readonly elementId: string; readonly kind: "linear-bend" }
  | { readonly axisIndex: number; readonly elementId: string; readonly kind: "coordinate-axis" }
  | { readonly elementId: string; readonly kind: "coordinate-origin" }
  | { readonly elementId: string; readonly kind: "table-header" }
  | {
      readonly elementId: string;
      readonly kind: "table-column";
      readonly separatorIndex: number;
    };

export type SelectionPreviewTransform =
  | { readonly delta: PointV1; readonly kind: "translate" }
  | {
      readonly anchor: PointV1;
      readonly delta: PointV1;
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
  readonly previewFrame: SelectionPreviewFrame | null;
  readonly snapCandidate: SnapCandidate | null;
  readonly snapGuide: SelectionSnapGuide | null;
  readonly transform: SelectionPreviewTransform | null;
}

export interface SelectionPreviewFrame {
  readonly points: readonly [PointV1, PointV1, PointV1, PointV1];
  readonly rotation: number;
}

export type SelectionSnapGuide =
  | { readonly kind: "anchor"; readonly point: PointV1 }
  | {
      readonly additionalStarts?: readonly PointV1[];
      readonly end: PointV1;
      readonly kind: "angular";
      readonly start: PointV1;
    }
  | {
      readonly end: PointV1;
      readonly handle: PointV1;
      readonly kind: "separator";
      readonly start: PointV1;
    }
  | {
      readonly handle: PointV1;
      readonly kind: "rotation";
      readonly opposite: PointV1;
    }
  | {
      readonly alignment: "straight" | "symmetric";
      readonly curvePoint: PointV1;
      readonly end: PointV1;
      readonly kind: "bend";
      readonly start: PointV1;
    };

export interface SelectionSnapPorts {
  readonly canConnect?: (sourceId: string, targetId: string) => boolean;
  readonly features?: SelectionSnapFeatures;
  readonly pointerType: SnapLookupInput["pointerType"];
  readonly spatial: SpatialCandidateQuery;
  readonly targets: SnapTargetReader;
  readonly zoom: number;
}

export interface SelectionSnapFeatures {
  readonly angles: boolean;
  readonly bends: boolean;
  readonly connections: boolean;
  readonly structures: boolean;
}

export interface SelectionHandleSessionOptions {
  readonly action: SelectionHandleAction;
  readonly elements: readonly InkElementV1[];
  readonly planner: SelectionReplacementPlanner;
  readonly requiresConnectionPreparation?: () => boolean;
  readonly preparedFrame?: SelectionPreviewFrame | null;
  readonly snap?: SelectionSnapPorts;
  readonly startPointer: PointV1;
  readonly uniformScale?: boolean;
}

export interface SelectionHandleUpdateOptions {
  readonly snapFeatures?: SelectionSnapFeatures;
  readonly uniformScale?: boolean;
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
