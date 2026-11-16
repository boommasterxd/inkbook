import type { MountedSceneElement } from "../content/mounted-element";
import type { ProgressivePreviewTransform } from "./progressive-preview-request";
import { canonicalRunMember } from "./selection-run-plan";
import { composeMatrices, inverseMatrix, matrixString } from "./selection-run-residuals";

export interface PublishedSelectionTranslation {
  readonly feedback: ProgressivePreviewTransform;
  readonly version: number;
}

export function isSelectionTranslation(
  feedback: ProgressivePreviewTransform | undefined,
): feedback is ProgressivePreviewTransform & {
  readonly matrix: readonly [number, number, number, number, number, number];
} {
  const matrix = feedback?.matrix;
  return (
    matrix !== undefined &&
    matrix.every(Number.isFinite) &&
    matrix[0] === 1 &&
    matrix[1] === 0 &&
    matrix[2] === 0 &&
    matrix[3] === 1
  );
}

/** Proves that only this gesture's published translation decorates canonical geometry. */
export class SelectionRunTranslation {
  #published: (() => PublishedSelectionTranslation | undefined) | undefined;
  #enabled = false;

  public stage(
    selection: ReadonlySet<string> | undefined,
    request: PublishedSelectionTranslation,
    published: () => PublishedSelectionTranslation | undefined,
  ): boolean {
    const previous = published();
    this.#enabled =
      isSelectionTranslation(request.feedback) &&
      selection === request.feedback.selection &&
      selection?.size === request.feedback.selectionSize &&
      (previous === undefined ||
        (isSelectionTranslation(previous.feedback) &&
          previous.feedback.selection === selection &&
          previous.feedback.selectionSize === selection?.size));
    this.#published = this.#enabled ? published : undefined;
    return this.#enabled;
  }

  public accepts(entry: MountedSceneElement): boolean {
    const published = this.#published?.();
    if (!this.#enabled || published === undefined) return canonicalRunMember(entry);
    const { feedback, version } = published;
    return (
      entry.displayedPathParts === entry.pathParts &&
      !entry.motionActive &&
      !entry.fadeActive &&
      entry.previewTransformVersion === version &&
      (entry.appliedPreviewTransform === feedback.transform ||
        entry.appliedPreviewTransform === matrixString(feedback.matrix!)) &&
      entry.appliedPreviewMatrix?.every((value, index) => value === feedback.matrix?.[index]) ===
        true
    );
  }

  public clear(): void {
    this.#enabled = false;
    this.#published = undefined;
  }
}

/** Retains the last complete local basis while ordinary run parents take over. */
export class SelectionRunTranslationBasis {
  #basis: ProgressivePreviewTransform | undefined;

  public adopt(published: PublishedSelectionTranslation | undefined): void {
    this.#basis = published?.feedback;
  }

  public resolve(feedback: ProgressivePreviewTransform): ProgressivePreviewTransform | undefined {
    if (this.#basis?.matrix === undefined || feedback.matrix === undefined) return feedback;
    const matrix = composeMatrices(feedback.matrix, inverseMatrix(this.#basis.matrix));
    const inverse = matrix.every(Number.isFinite) ? inverseMatrix(matrix) : undefined;
    if (inverse === undefined) return undefined;
    return {
      ...feedback,
      matrix,
      transform: matrixString(matrix),
      inverse: matrixString(inverse),
    };
  }

  public takeInverse(): ProgressivePreviewTransform | undefined {
    const basis = this.#basis;
    this.#basis = undefined;
    if (basis?.matrix === undefined) return undefined;
    const matrix = inverseMatrix(basis.matrix)!;
    return { ...basis, matrix, transform: matrixString(matrix), inverse: basis.transform };
  }

  public clear(): void {
    this.#basis = undefined;
  }

  public memoryUsage(): number {
    return this.#basis === undefined ? 0 : 64 + this.#basis.transform.length * 2;
  }
}
