import type { PreviewTransform } from "../reconciliation/scene-mount-preparation";
import type { PreviewRequest, ProgressivePreviewTransform } from "./progressive-preview-request";
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

/** Reuses one no-basis result; individual canonical snapshot bases keep their own calculation. */
export class ProgressiveFeedbackTransformCache {
  #request: PreviewRequest | undefined;
  #version = 0;
  #zoom = 1;
  #preview: PreviewTransform | undefined;

  public resolve(
    request: PreviewRequest | undefined,
    basis: ProgressivePreviewTransform | undefined,
    zoom: number,
  ): PreviewTransform {
    const version = request?.version ?? 0;
    if (basis !== undefined)
      return progressiveFeedbackTransform(request?.feedback, basis, version, zoom);
    if (
      this.#preview === undefined ||
      request !== this.#request ||
      version !== this.#version ||
      zoom !== this.#zoom
    ) {
      this.#request = request;
      this.#version = version;
      this.#zoom = zoom;
      this.#preview = progressiveFeedbackTransform(request?.feedback, undefined, version, zoom);
    }
    return this.#preview;
  }

  public memoryUsage(): number {
    const preview = this.#preview;
    // Reserve one result and six numeric coefficients even for opaque or null feedback.
    return preview === undefined
      ? 0
      : 128 + 6 * Float64Array.BYTES_PER_ELEMENT + (preview.transform?.length ?? 0) * 2;
  }

  public clear(): void {
    this.#request = undefined;
    this.#preview = undefined;
  }
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
