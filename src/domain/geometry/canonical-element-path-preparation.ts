import { strokeLocalGeometry } from "./stroke-position";
import { isStoredStroke } from "../elements/stroke-replacement-proof";
import { strokeCenterWindow } from "./stroke-center-window";
import type {
  PreparedPressureGeometryPort,
  PressureWindowMeasurement,
  PressurePathWindow,
  PressurePreparationMode,
} from "./pressure/prepared-pressure-geometry";
import { buildElementPathParts, type SvgPathPart } from "./element-path";
import { buildCenterline } from "./stroke-path";
import { type simplifyStrokeCenters, STROKE_SIMPLIFICATION_WINDOW } from "./stroke-simplification";
import {
  visitPreparedPressureOutline,
  type PressureOutlinePiece,
} from "./pressure/pressure-outline";
import {
  pressureWindowMemoryUsage,
  pressureOutlinePieceMemoryUsage,
  serializePressureWindows,
  type PressureWindow,
} from "./pressure/pressure-path-serialization";
import {
  preparePressureWindowSteps,
  PRESSURE_WINDOW_SCRATCH_BYTES,
} from "./pressure/pressure-window";
import type { InkElementV1, StrokeElementV1 } from "../schema/public";

/** Prepares canonical simplification and contour pieces in bounded windows. */
export class CanonicalElementPathPreparation {
  readonly #element: InkElementV1;
  readonly #reuseCenters: boolean;
  readonly #selected: ReturnType<typeof simplifyStrokeCenters> = [];
  readonly #windows: (PressureWindow | PressurePathWindow)[] = [];
  readonly #pendingPieces: PressureOutlinePiece[] = [];
  #windowBytes = 0;
  #windowJob: Generator<void, PressureWindow | PressurePathWindow> | undefined;
  #geometryPrepared = false;
  readonly #chunks: string[] = [];
  #prepared = 0;
  #boundary = 0;
  #parts: readonly SvgPathPart[] | undefined;
  #cancelled = false;

  public constructor(
    element: InkElementV1,
    private pressureGeometry?: PreparedPressureGeometryPort,
    private readonly mode: PressurePreparationMode = "full",
  ) {
    if (mode === "path-only" && pressureGeometry !== undefined)
      throw new TypeError("Path-only preparation cannot publish selection geometry.");
    this.#reuseCenters = element.kind === "stroke" && isStoredStroke(element);
    element = element.kind === "stroke" ? strokeLocalGeometry(element) : element;
    this.#element = element;
    if (element.kind === "stroke") {
      this.#parts = element.style.pressureEnabled ? pressureGeometry?.readPath?.() : undefined;
    }
  }

  public get parts(): readonly SvgPathPart[] | undefined {
    return this.#parts;
  }

  public memoryUsage(): number {
    const geometry =
      this.#parts?.reduce((bytes, part) => bytes + part.d.length * 2, 0) ??
      this.#chunks.reduce((bytes, chunk) => bytes + chunk.length * 2, 0);
    const windowBytes =
      this.mode === "path-only"
        ? this.#windows.reduce((bytes, window) => bytes + pressureWindowMemoryUsage(window), 0)
        : this.#windowBytes;
    return (
      geometry +
      this.#selected.length * 32 +
      windowBytes +
      (this.#windowJob === undefined ? 0 : PRESSURE_WINDOW_SCRATCH_BYTES) +
      this.#pendingPieces.reduce(
        (bytes, piece) => bytes + pressureOutlinePieceMemoryUsage(piece),
        0,
      )
    );
  }

  public step(deadline = Infinity, now: () => number = () => 0): boolean {
    return this.prepare(deadline, now, false);
  }

  /** One cancellable union operation; the caller's scheduler controls every handoff. */
  public stepOperation(): boolean {
    return this.prepare(Infinity, () => 0, true);
  }

  private prepare(deadline: number, now: () => number, singleOperation: boolean): boolean {
    if (this.#cancelled) return false;
    if (this.#parts !== undefined) return true;
    const element = this.#element;
    if (element.kind !== "stroke") {
      this.#parts = buildElementPathParts(element);
      return true;
    }
    return this.prepareStroke(element, deadline, now, singleOperation);
  }

  private prepareStroke(
    element: StrokeElementV1,
    deadline: number,
    now: () => number,
    singleOperation: boolean,
  ): boolean {
    const pointCount = element.points.length / 3;
    if (this.#prepared < pointCount - 1 || this.#selected.length === 0) {
      const next = Math.min(pointCount - 1, this.#prepared + STROKE_SIMPLIFICATION_WINDOW);
      const index = this.#prepared / STROKE_SIMPLIFICATION_WINDOW;
      const retained = this.#reuseCenters ? this.pressureGeometry?.readCenters?.(index) : undefined;
      const selected =
        retained ??
        strokeCenterWindow(element, index, {
          validate: true,
          first: this.#selected[this.#selected.length - 1],
        });
      this.#selected.push(...(this.#selected.length === 0 ? selected : selected.slice(1)));
      this.#prepared = next;
      if (next < pointCount - 1) return false;
    }
    if (this.hasPendingWindow()) {
      if (!this.advancePressureWindow(deadline, now, singleOperation)) return false;
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

  public cancel(): void {
    this.#cancelled = true;
    this.#parts = undefined;
    this.#windowJob?.return(undefined as never);
    this.#windowJob = undefined;
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
    return true;
  }
  private advancePressureWindow(
    deadline: number,
    now: () => number,
    singleOperation: boolean,
  ): boolean {
    if (this.#pendingPieces.length === 0) return true;
    const count = Math.min(64, this.#pendingPieces.length);
    const measurement =
      this.#windowJob === undefined
        ? this.pressureGeometry?.readWindowMeasurement?.(this.#windows.length)
        : undefined;
    const cached =
      this.#windowJob === undefined
        ? this.pressureGeometry?.readWindowMeasurement === undefined
          ? this.pressureGeometry?.readWindow(this.#windows.length)
          : measurement?.window
        : undefined;
    if (cached !== undefined) {
      this.acceptWindow(cached, count, measurement);
      return this.#pendingPieces.length === 0;
    }
    this.#windowJob ??=
      this.mode === "path-only"
        ? preparePressureWindowSteps(this.#pendingPieces.slice(0, count), "path-only")
        : preparePressureWindowSteps(this.#pendingPieces.slice(0, count));
    let started = false;
    for (;;) {
      if (started && (singleOperation || now() >= deadline)) return false;
      started = true;
      const step = this.#windowJob.next();
      if (!step.done) continue;
      const measurement =
        step.value.kind === "window"
          ? this.pressureGeometry?.publishWindow(this.#windows.length, step.value)
          : undefined;
      this.acceptWindow(step.value, count, measurement);
      return this.#pendingPieces.length === 0;
    }
  }

  private acceptWindow(
    window: PressureWindow | PressurePathWindow,
    count: number,
    measurement?: PressureWindowMeasurement | void,
  ): void {
    this.#windows.push(window);
    this.#windowBytes +=
      measurement?.window === window &&
      Number.isSafeInteger(measurement.numericBytes) &&
      measurement.numericBytes >= 0
        ? measurement.numericBytes
        : window.kind === "window"
          ? pressureWindowMemoryUsage(window)
          : 0;
    this.#pendingPieces.splice(0, count);
    this.#windowJob = undefined;
  }
}
