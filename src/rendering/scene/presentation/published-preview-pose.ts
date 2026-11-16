import { SelectionFeedbackTransforms } from "./selection-feedback-transforms";
import type { PreviewTransform } from "../reconciliation/scene-visibility-reconciler";

const CANONICAL: PreviewTransform = {
  transform: "matrix(1 0 0 1 0 0)",
  matrix: [1, 0, 0, 1, 0, 0],
  version: 0,
  strokeWidthScale: null,
};

/** Culling reads only the last fully published common pose while a newer request waits. */
export class PublishedPreviewPose {
  #ids: readonly string[] = [];
  #members = new Set<string>();
  #preview: PreviewTransform = CANONICAL;
  public readonly values = new SelectionFeedbackTransforms({
    size: () => this.#ids.length,
    ids: () => this.#ids,
    get: (id) => (this.#members.has(id) ? this.#preview : undefined),
  });
  public hold(ids: readonly string[]): void {
    if (this.#ids.length === 0) this.publish(ids, CANONICAL);
  }
  public publish(ids: readonly string[], preview: PreviewTransform = CANONICAL): void {
    if (ids !== this.#ids) {
      this.#ids = ids;
      this.#members = new Set(ids);
    }
    this.#preview = preview;
  }
  public clear(): void {
    this.#ids = [];
    this.#members.clear();
    this.#preview = CANONICAL;
  }
}
