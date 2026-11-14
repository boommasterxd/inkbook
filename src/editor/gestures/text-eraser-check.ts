import {
  prepareTextPaintGeometrySteps,
  type TextPaintGeometry,
} from "../../domain/geometry/text-paint-geometry";
import type { Bounds } from "../../domain/geometry/primitives";
import type { TextPaintRegion } from "../../domain/geometry/text-paint-regions";
import type { TextElementV2 } from "../../domain/schema/public";
import type { NumericSegment } from "./eraser-segment";
import { textRegionTouchesSweep } from "../../domain/geometry/text-paint-region-distance";

/** One advancement admits one preparation/index step or tests one visible paint region. */
export class TextEraserCheck {
  readonly #sweep: NumericSegment;
  readonly #radius: number;
  readonly #bounds: Bounds;
  #preparation: Generator<void, TextPaintGeometry> | undefined;
  #regions: Generator<void | TextPaintRegion> | undefined;

  public constructor(
    sweep: NumericSegment,
    radius: number,
    element: TextElementV2,
    geometry?: TextPaintGeometry,
  ) {
    this.#sweep = {
      startX: sweep.startX - element.x,
      startY: sweep.startY - element.y,
      endX: sweep.endX - element.x,
      endY: sweep.endY - element.y,
    };
    this.#radius = radius;
    this.#bounds = {
      minX: Math.min(this.#sweep.startX, this.#sweep.endX) - radius,
      minY: Math.min(this.#sweep.startY, this.#sweep.endY) - radius,
      maxX: Math.max(this.#sweep.startX, this.#sweep.endX) + radius,
      maxY: Math.max(this.#sweep.startY, this.#sweep.endY) + radius,
    };
    if (geometry) this.#regions = geometry.querySteps(this.#bounds);
    else this.#preparation = prepareTextPaintGeometrySteps(element);
  }

  public advanceOne(): boolean | null {
    if (this.#preparation) {
      const step = this.#preparation.next();
      if (step.done) {
        this.#regions = step.value.querySteps(this.#bounds);
        this.#preparation = undefined;
      }
      return null;
    }
    const step = this.#regions!.next();
    if (step.done) return false;
    return step.value && textRegionTouchesSweep(step.value, this.#sweep, this.#radius)
      ? true
      : null;
  }
}
