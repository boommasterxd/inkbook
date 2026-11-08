import type { PathCommand } from "../documents/path-data-validator";

/** Conservative painted bounds use the actual path, independently of editable metadata. */
export class StaticPathBounds {
  #minimum = Infinity;
  #maximum = -Infinity;

  public observe(
    command: PathCommand,
    values: readonly number[],
    startY: number,
    endY: number,
    startX: number,
  ): void {
    if (command === "A" || command === "a") {
      this.#includeArc(values, { startX, startY, endY, relative: command === "a" });
      return;
    }
    this.#include(endY);
    if (command === "M") return;
    this.#include(startY);
    if (command === "Q" || command === "q") {
      this.#include(values[1]! + (command === "q" ? startY : 0));
    } else if (command === "C") {
      this.#include(values[1]!);
      this.#include(values[3]!);
    }
  }

  public painted(translationY: number, strokeWidth: number): { minY: number; maxY: number } {
    // SVG's default miter limit is four half-widths; this also contains square caps.
    const padding = strokeWidth * 2;
    return {
      minY: this.#minimum + translationY - padding,
      maxY: this.#maximum + translationY + padding,
    };
  }

  #include(y: number): void {
    this.#minimum = Math.min(this.#minimum, y);
    this.#maximum = Math.max(this.#maximum, y);
  }

  #includeArc(
    values: readonly number[],
    position: { startX: number; startY: number; endY: number; relative: boolean },
  ): void {
    const endX = values[5]! + (position.relative ? position.startX : 0);
    const dx = position.relative ? -values[5]! / 2 : (position.startX - endX) / 2;
    const dy = position.relative ? -values[6]! / 2 : (position.startY - position.endY) / 2;
    this.#include(position.startY);
    this.#include(position.endY);
    // SVG omits arcs whose endpoints coincide, regardless of radii or flags.
    if (dx === 0 && dy === 0) return;
    const radiusX = values[0]!;
    const radiusY = values[1]!;
    const lambda = (dx / radiusX) ** 2 + (dy / radiusY) ** 2;
    // The center is at most one corrected radius from the midpoint; cover both ellipses.
    // The wider bound avoids ill-conditioned center calculations near antipodal endpoints.
    const extent = 2 * radiusY * Math.max(1, Math.sqrt(lambda));
    const middleY = (position.startY + position.endY) / 2;
    const rounding =
      Number.EPSILON *
      32 *
      Math.max(1, Math.abs(position.startX), Math.abs(endX), Math.abs(middleY), extent);
    if (!(lambda > 0) || !Number.isFinite(extent + rounding)) {
      this.#minimum = -Infinity;
      this.#maximum = Infinity;
      return;
    }
    this.#include(middleY - extent - rounding);
    this.#include(middleY + extent + rounding);
  }
}
