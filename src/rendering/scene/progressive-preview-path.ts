import type { PreparedPressureGeometryPort } from "../../domain/geometry/prepared-pressure-geometry";
import { buildElementPathParts, type SvgPathPart } from "../../domain/geometry/element-path";
import {
  transformedStrokeCenters,
  buildCenterline,
  type StrokeCenter,
} from "../../domain/geometry/stroke-path";
import {
  simplifyStrokeCenters,
  STROKE_SIMPLIFICATION_WINDOW,
} from "../../domain/geometry/stroke-simplification";
import {
  visitPreparedPressureOutline,
  type PressureOutlinePiece,
} from "../../domain/geometry/pressure-outline";
import {
  pressureWindowMemoryUsage,
  pressureOutlinePieceMemoryUsage,
  serializePressureWindows,
  type PressureWindow,
} from "../../domain/geometry/pressure-path-serialization";
import {
  preparePressureWindowSteps,
  PRESSURE_WINDOW_SCRATCH_BYTES,
} from "../../domain/geometry/pressure-window";
import type { InkElementV1 } from "../../domain/schema/public";

/** Prepares canonical simplification and contour pieces in bounded windows. */
export class ProgressivePreviewPath {
  readonly #element: InkElementV1;
  #centers: readonly StrokeCenter[] | undefined;
  readonly #selected: ReturnType<typeof simplifyStrokeCenters> = [];
  readonly #windows: PressureWindow[] = [];
  readonly #pendingPieces: PressureOutlinePiece[] = [];
  #windowBytes = 0;
  #windowJob: Generator<void, PressureWindow> | undefined;
  #geometryPrepared = false;
  readonly #chunks: string[] = [];
  #prepared = 0;
  #boundary = 0;
  #parts: readonly SvgPathPart[] | undefined;

  public constructor(
    element: InkElementV1,
    private readonly pressureGeometry?: PreparedPressureGeometryPort,
  ) {
    this.#element = element;
    if (element.kind === "stroke") this.#centers = transformedStrokeCenters(element);
  }

  public get parts(): readonly SvgPathPart[] | undefined {
    return this.#parts;
  }

  public memoryUsage(): number {
    const geometry =
      this.#parts?.reduce((bytes, part) => bytes + part.d.length * 2, 0) ??
      this.#chunks.reduce((bytes, chunk) => bytes + chunk.length * 2, 0);
    return (
      geometry +
      ((this.#centers?.length ?? 0) + this.#selected.length) * 32 +
      this.#windowBytes +
      (this.#windowJob === undefined ? 0 : PRESSURE_WINDOW_SCRATCH_BYTES) +
      this.#pendingPieces.reduce(
        (bytes, piece) => bytes + pressureOutlinePieceMemoryUsage(piece),
        0,
      )
    );
  }

  public step(deadline = Infinity, now: () => number = () => 0): boolean {
    if (this.#parts !== undefined) return true;
    const element = this.#element;
    const centers = this.#centers;
    if (centers === undefined || element.kind !== "stroke") {
      this.#parts = buildElementPathParts(element);
      return true;
    }
    if (this.#prepared < centers.length - 1 || this.#selected.length === 0) {
      const next = Math.min(centers.length - 1, this.#prepared + STROKE_SIMPLIFICATION_WINDOW);
      const selected = simplifyStrokeCenters(
        centers.slice(this.#prepared, next + 1),
        element.style.width,
        element.style.pressureEnabled,
      );
      this.#selected.push(...(this.#selected.length === 0 ? selected : selected.slice(1)));
      this.#prepared = next;
      if (next < centers.length - 1) return false;
    }
    if (this.hasPendingWindow()) {
      if (!this.advancePressureWindow(deadline, now)) return false;
      if (this.#geometryPrepared) return this.finishGeometry();
    }
    const end = Math.min(this.#selected.length - 1, this.#boundary + 64);
    if (element.style.pressureEnabled) {
      visitPreparedPressureOutline(
        this.#selected,
        element.style.width,
        (piece) => {
          this.#pendingPieces.push(piece);
          return false;
        },
        {
          firstBoundary: this.#boundary === 0 ? null : this.#boundary,
          lastBoundary: end === this.#selected.length - 1 ? null : end,
        },
      );
    } else {
      const d = buildCenterline(this.#selected.slice(this.#boundary, end + 1));
      this.#chunks.push(this.#boundary === 0 ? d : d.slice(d.indexOf("L")));
    }
    this.#boundary = end;
    if (end < this.#selected.length - 1) return false;
    this.#geometryPrepared = true;
    return element.style.pressureEnabled ? false : this.finishGeometry();
  }

  private hasPendingWindow(): boolean {
    return (
      this.#windowJob !== undefined || this.#pendingPieces.length >= 64 || this.#geometryPrepared
    );
  }

  private finishGeometry(): boolean {
    const element = this.#element;
    if (element.kind !== "stroke") return false;
    this.#parts = [
      {
        d: element.style.pressureEnabled
          ? serializePressureWindows(this.#windows)
          : this.#chunks.join(""),
        paint: element.style.pressureEnabled ? "fill" : "stroke",
      },
    ];
    this.#chunks.length = 0;
    this.#selected.length = 0;
    this.#windows.length = 0;
    this.#windowBytes = 0;
    this.#centers = undefined;
    return true;
  }
  private advancePressureWindow(deadline: number, now: () => number): boolean {
    if (this.#pendingPieces.length === 0) return true;
    const count = Math.min(64, this.#pendingPieces.length);
    this.#windowJob ??= preparePressureWindowSteps(this.#pendingPieces.slice(0, count));
    for (let index = 0; index < 4096; index++) {
      if (index > 0 && now() >= deadline) return false;
      const step = this.#windowJob.next();
      if (!step.done) continue;
      this.pressureGeometry?.publishWindow(this.#windows.length, step.value);
      this.#windows.push(step.value);
      this.#windowBytes += pressureWindowMemoryUsage(step.value);
      this.#pendingPieces.splice(0, count);
      this.#windowJob = undefined;
      return this.#pendingPieces.length === 0;
    }
    return false;
  }
}
