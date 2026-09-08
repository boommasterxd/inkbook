import { buildElementPathParts, type SvgPathPart } from "../../domain/geometry/element-path";
import { transformedStrokeCenters, type StrokeCenter } from "../../domain/geometry/stroke-path";
import {
  buildCenterlineSlice,
  buildPressureOutlineSlice,
} from "../../domain/geometry/stroke-path-slice";
import type { InkElementV1 } from "../../domain/schema/public";

/** Builds the canonical stroke path in bounded slices without publishing partial ink. */
export class ProgressivePreviewPath {
  readonly #element: InkElementV1;
  #centers: readonly StrokeCenter[] | undefined;
  readonly #chunks: string[] = [];
  #boundary: number | null = null;
  #parts: readonly SvgPathPart[] | undefined;

  public constructor(element: InkElementV1) {
    this.#element = element;
    if (element.kind === "stroke") {
      this.#centers = transformedStrokeCenters(element);
    }
  }

  public get parts(): readonly SvgPathPart[] | undefined {
    return this.#parts;
  }

  public memoryUsage(): number {
    const geometry =
      this.#parts?.reduce((bytes, part) => bytes + part.d.length * 2, 0) ??
      this.#chunks.reduce((bytes, chunk) => bytes + chunk.length * 2, 0);
    return geometry + (this.#centers?.length ?? 0) * 32;
  }

  public step(): boolean {
    if (this.#parts !== undefined) return true;
    const element = this.#element;
    const centers = this.#centers;
    if (centers === undefined || element.kind !== "stroke") {
      this.#parts = buildElementPathParts(element);
      return true;
    }
    // Each slice owns at most 64 canonical midpoint curves.
    const next = this.#boundary === null ? 59 : this.#boundary + 64;
    const lastBoundary = next >= centers.length - 2 ? null : next;
    const slice = { firstBoundary: this.#boundary, lastBoundary };
    const parts = element.style.pressureEnabled
      ? buildPressureOutlineSlice(centers, element.style.width, slice)
      : buildCenterlineSlice(centers, slice);
    const part = parts[0]!;
    this.#chunks.push(
      part.paint === "stroke" && this.#boundary !== null
        ? part.d.replace(/^M[^A-Z]*/u, "")
        : part.d,
    );
    this.#boundary = lastBoundary;
    if (lastBoundary !== null) return false;
    this.#parts = [{ d: this.#chunks.join(""), paint: part.paint }];
    this.#chunks.length = 0;
    this.#centers = undefined;
    return true;
  }
}
