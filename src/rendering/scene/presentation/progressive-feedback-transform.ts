import type { PreviewTransform } from "../reconciliation/scene-mount-preparation";
import type { ProgressivePreviewTransform } from "./progressive-preview-request";
import type { SceneContentRenderer } from "../content-renderer";
import {
  composeMatrices,
  inverseMatrix,
  matrixString,
  IDENTITY_MATRIX,
} from "./selection-run-residuals";

/** Feedback is relative to the canonical snapshot that is actually mounted. */
export function progressiveFeedbackTransform(
  feedback: ProgressivePreviewTransform | undefined,
  basis: ProgressivePreviewTransform | undefined,
  version: number,
  zoom: number,
): PreviewTransform {
  if (feedback === undefined || feedback.transform === basis?.transform)
    return { transform: null, strokeWidthScale: null, version };
  const inverse =
    basis === undefined
      ? IDENTITY_MATRIX
      : basis.matrix?.every(Number.isFinite)
        ? inverseMatrix(basis.matrix)
        : undefined;
  const composed =
    feedback.matrix?.every(Number.isFinite) && inverse !== undefined
      ? composeMatrices(feedback.matrix, inverse)
      : undefined;
  const matrix = composed?.every(Number.isFinite) ? composed : undefined;
  return {
    strokeWidthScale: zoom,
    version,
    matrix,
    transform:
      matrix === undefined
        ? `${feedback.transform}${basis === undefined ? "" : ` ${basis.inverse}`}`
        : matrixString(matrix),
  };
}

/** Optional numeric metadata supplements the existing legacy writer contract. */
export function writeFeedback(
  content: Pick<SceneContentRenderer, "applyPreviewTransform">,
  id: string,
  preview: PreviewTransform,
): void {
  const args = [id, preview.transform, preview.version, preview.strokeWidthScale] as const;
  if (preview.transform !== null && preview.matrix !== undefined)
    content.applyPreviewTransform(...args, preview.matrix);
  else content.applyPreviewTransform(...args);
}
