import { sameBounds } from "../visibility/visibility-bounds";
import type { Bounds } from "../../../domain/geometry/primitives";
import { multiplyAffineMatrices, type AffineMatrix } from "../../../domain/geometry/affine-matrix";
import type { TextElementV2 } from "../../../domain/schema/types";
import {
  inverseTextMatrix,
  textPreviewMatrix,
  textRectBounds,
  textBasisRebaseMatrix,
} from "../text-editing-geometry";
import type { PreviewTransform } from "../reconciliation/scene-visibility-reconciler";
import type { MountedSceneElement } from "./mounted-element";
import type { MountedTextPresentation } from "./mounted-text";

/** Windowing reuses the scene's page viewport and admitted content lane, never a second scheduler. */
export class TextViewportPublication {
  #bounds: Bounds | undefined;
  #scan: MapIterator<string> | undefined;
  readonly #texts = new Map<string, MountedTextPresentation>();
  readonly #pending = new Set<string>();
  #scanNext = true;

  public constructor(
    private readonly mounted: ReadonlyMap<string, MountedSceneElement>,
    private readonly transform: (id: string) => PreviewTransform | undefined,
  ) {}

  public get pending(): boolean {
    return this.#scan !== undefined || this.#pending.size > 0;
  }

  public memoryUsage(): number {
    return (this.#pending.size + this.#texts.size) * 40 + (this.#scan === undefined ? 0 : 128);
  }

  public set(bounds: Bounds | undefined): void {
    if (sameBounds(this.#bounds, bounds)) return;
    this.#bounds = bounds;
    this.refresh();
  }

  public mount(entry: MountedSceneElement): void {
    if (!entry.text) return;
    this.#texts.set(entry.id, entry.text);
    this.#pending.add(entry.id);
  }

  public remove(id: string): void {
    this.#texts.get(id)?.cancelViewport();
    this.#texts.delete(id);
    this.#pending.delete(id);
  }

  public invalidate(id: string): void {
    if (this.#texts.has(id)) this.#pending.add(id);
  }

  public refresh(): void {
    this.#scan ??= this.#texts.keys();
  }

  public readonly localBounds = (
    element: TextElementV2,
    detachedPreview?: AffineMatrix,
  ): Bounds | undefined => {
    const viewport = this.#bounds;
    if (!viewport) return undefined;
    const entry = this.mounted.get(element.id);
    let matrix =
      this.transform(element.id)?.matrix ?? entry?.text?.previewMatrix ?? detachedPreview;
    if (entry?.textScaleFeedback) {
      const feedback = entry.textScaleFeedback;
      matrix =
        element === feedback.basis
          ? feedback.matrix
          : multiplyAffineMatrices(feedback.matrix, textBasisRebaseMatrix(element, feedback.basis));
    }
    if (entry?.motionActive) {
      const scale = entry.text?.motionScale ?? 1;
      matrix = [scale, 0, 0, scale, element.pivot.x * (1 - scale), element.pivot.y * (1 - scale)];
    }
    const inverse = inverseTextMatrix(textPreviewMatrix(element, matrix));
    if (!inverse) return undefined;
    const bounds = textRectBounds(
      {
        left: viewport.minX,
        top: viewport.minY,
        right: viewport.maxX,
        bottom: viewport.maxY,
      },
      inverse,
    );
    return (
      bounds && {
        minX: bounds.minX - element.x,
        minY: bounds.minY - element.y,
        maxX: bounds.maxX - element.x,
        maxY: bounds.maxY - element.y,
      }
    );
  };

  public write(deadline: number, now: () => number): boolean {
    let stepped = false;
    while (this.pending) {
      if (stepped && now() >= deadline) return true;
      if (this.#scan && (this.#scanNext || this.#pending.size === 0)) {
        const next = this.#scan.next();
        if (next.done) this.#scan = undefined;
        else this.invalidate(next.value);
        this.#scanNext = false;
      } else {
        const id = this.#pending.values().next().value!;
        this.#pending.delete(id);
        if (this.#texts.get(id)?.prepareViewport(deadline, now) === false) this.#pending.add(id);
        this.#scanNext = true;
      }
      stepped = true;
    }
    return false;
  }

  public release(): void {
    this.#scan = undefined;
    for (const text of this.#texts.values()) text.cancelViewport();
    this.#texts.clear();
    this.#pending.clear();
  }
}
