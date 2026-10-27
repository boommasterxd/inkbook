import type { InkElementV1 } from "../../../domain/schema/public";
import type { SvgPathPart } from "../../../domain/geometry/element-path";
import type { PreviewBoundsTransform } from "../types";
import type { ProgressivePreviewPath } from "../content/progressive-preview-path";

export interface ProgressivePreviewTransform {
  readonly matrix?: readonly [number, number, number, number, number, number];
  readonly selection?: ReadonlySet<string>;
  readonly selectionSize?: number;
  readonly invertible?: boolean;
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

/** Keeps canonical snapshot work pending until every requested member is prepared. */
export function hasPendingPreviewSnapshots(
  request: PreviewRequest | undefined,
  versions: ReadonlyMap<string, number>,
  remainingConnected: number,
  replayCount: number,
): boolean {
  if (replayCount > 0) return true;
  return request?.connected
    ? remainingConnected > 0
    : (request?.ids.some((id) => versions.get(id) !== request.version) ?? false);
}
