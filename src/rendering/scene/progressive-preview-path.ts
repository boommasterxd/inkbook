import { strokeLocalGeometry } from "../../domain/geometry/stroke-position";
import { localPressureGeometry } from "./stroke-position";
import type {
  PreparedPressureGeometryPort,
  PressureWindowMeasurement,
} from "../../domain/geometry/prepared-pressure-geometry";
import { buildElementPathParts, type SvgPathPart } from "../../domain/geometry/element-path";
import {
  iterateTransformedStrokeCenters,
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
import type { InkElementV1, StrokeElementV1 } from "../../domain/schema/public";

/** Prepares canonical simplification and contour pieces in bounded windows. */
export class ProgressivePreviewPath {
  readonly #element: InkElementV1;
  #centers: StrokeCenter[] | undefined;
  #centerJob: Generator<StrokeCenter> | undefined;
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
  #cancelled = false;

  public constructor(
    element: InkElementV1,
    private pressureGeometry?: PreparedPressureGeometryPort,
  ) {
    this.pressureGeometry = localPressureGeometry(element, pressureGeometry);
    pressureGeometry = this.pressureGeometry;
    element = element.kind === "stroke" ? strokeLocalGeometry(element) : element;
    this.#element = element;
    if (element.kind === "stroke") {
      this.#parts = element.style.pressureEnabled ? pressureGeometry?.readPath?.() : undefined;
      if (this.#parts === undefined) {
        this.#centers = [];
        this.#centerJob = iterateTransformedStrokeCenters(element);
      }
    }
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
    if (this.#cancelled) return false;
    if (this.#parts !== undefined) return true;
    if (this.#centerJob !== undefined) this.prepareCenters();
    const element = this.#element;
    const centers = this.#centers;
    if (centers === undefined || element.kind !== "stroke") {
      this.#parts = buildElementPathParts(element);
      return true;
    }
    return this.prepareStroke(element, centers, deadline, now);
  }

  private prepareStroke(
    element: StrokeElementV1,
    centers: readonly StrokeCenter[],
    deadline: number,
    now: () => number,
  ): boolean {
    const pointCount = element.points.length / 3;
    if (this.#prepared < pointCount - 1 || this.#selected.length === 0) {
      const next = Math.min(pointCount - 1, this.#prepared + STROKE_SIMPLIFICATION_WINDOW);
      const selected = simplifyStrokeCenters(
        centers.slice(this.#prepared, next + 1),
        element.style.width,
        element.style.pressureEnabled,
      );
      this.#selected.push(...(this.#selected.length === 0 ? selected : selected.slice(1)));
      this.#prepared = next;
      if (next < pointCount - 1) return false;
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

  private prepareCenters(): void {
    if (this.#element.kind !== "stroke") return;
    const count = this.#element.points.length / 3;
    const next = Math.min(count, this.#prepared + STROKE_SIMPLIFICATION_WINDOW + 1);
    while (this.#centers!.length < next) {
      const step = this.#centerJob!.next();
      if (step.done) throw new Error("Stroke center preparation ended before its sample count.");
      this.#centers!.push(step.value);
    }
    if (next === count) {
      this.#centerJob!.return(undefined);
      this.#centerJob = undefined;
    }
  }

  public cancel(): void {
    this.#cancelled = true;
    this.#parts = undefined;
    this.#centerJob?.return(undefined);
    this.#windowJob?.return(undefined as never);
    this.#centerJob = undefined;
    this.#windowJob = undefined;
    this.#centers = undefined;
    this.#selected.length = 0;
    this.#windows.length = 0;
    this.#pendingPieces.length = 0;
    this.#chunks.length = 0;
    this.#windowBytes = 0;
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
    if (element.style.pressureEnabled) this.pressureGeometry?.publishPath?.(this.#parts);
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
    const cached =
      this.#windowJob === undefined
        ? this.pressureGeometry?.readWindow(this.#windows.length)
        : undefined;
    if (cached !== undefined) {
      this.acceptWindow(cached, count);
      return this.#pendingPieces.length === 0;
    }
    this.#windowJob ??= preparePressureWindowSteps(this.#pendingPieces.slice(0, count));
    for (let index = 0; index < 4096; index++) {
      if (index > 0 && now() >= deadline) return false;
      const step = this.#windowJob.next();
      if (!step.done) continue;
      const measurement = this.pressureGeometry?.publishWindow(this.#windows.length, step.value);
      this.acceptWindow(step.value, count, measurement);
      return this.#pendingPieces.length === 0;
    }
    return false;
  }

  private acceptWindow(
    window: PressureWindow,
    count: number,
    measurement?: PressureWindowMeasurement | void,
  ): void {
    this.#windows.push(window);
    this.#windowBytes +=
      measurement?.window === window &&
      Number.isSafeInteger(measurement.numericBytes) &&
      measurement.numericBytes >= 0
        ? measurement.numericBytes
        : pressureWindowMemoryUsage(window);
    this.#pendingPieces.splice(0, count);
    this.#windowJob = undefined;
  }
}
