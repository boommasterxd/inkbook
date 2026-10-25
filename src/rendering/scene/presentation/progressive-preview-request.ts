import type { InkElementV1 } from "../../../domain/schema/public";
import type { SvgPathPart } from "../../../domain/geometry/element-path";
import type { PreviewBoundsTransform } from "../types";
import type { ProgressivePreviewPath } from "../content/progressive-preview-path";

export interface ProgressivePreviewTransform {
  readonly transformBounds?: PreviewBoundsTransform;
  readonly transform: string;
  readonly inverse: string;
}

export interface PreviewRequest {
  readonly connected?: boolean;
  readonly feedback?: ProgressivePreviewTransform | undefined;
  readonly ids: readonly string[];
  readonly feedbackIds?: readonly string[];
  readonly isImmediate?: (id: string) => boolean;
  readonly affineElement?: ((id: string) => InkElementV1 | undefined) | undefined;
  readonly materialize: (id: string) => InkElementV1 | undefined;
  readonly version: number;
}

export interface CompletedPath {
  readonly feedback: ProgressivePreviewTransform | undefined;
  readonly element: InkElementV1;
  readonly parts: readonly SvgPathPart[];
}

export interface PendingPath {
  readonly feedback: ProgressivePreviewTransform | undefined;
  readonly element: InkElementV1;
  readonly path: ProgressivePreviewPath;
  readonly version: number;
  readonly pressureEnabled: boolean;
  readonly replay?: boolean;
}
