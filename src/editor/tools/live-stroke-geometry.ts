import {
  smoothStrokeCenters,
  buildCenterline,
  type StrokeCenter,
  type StrokePathGeometry,
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
  preparePressureWindows,
  serializePressureWindows,
  serializePressureCapsules,
  pressureWindowMemoryUsage,
  pressureOutlinePieceMemoryUsage,
  type PressureWindow,
} from "../../domain/geometry/pressure-path-serialization";
import type { StrokeStyleV1 } from "../../domain/schema/public";

export const LIVE_STROKE_WINDOW = STROKE_SIMPLIFICATION_WINDOW;
export const MAX_LIVE_TAIL_SAMPLES = 2 * LIVE_STROKE_WINDOW + 3;

/** Owns fixed-window simplification and immutable contour pieces; no raw prefix is rebuilt. */
export class LiveStrokeGeometry {
  private readonly pendingWindows = new Map<number, StrokeCenter[]>();
  private readonly pendingPaths = new Map<number, string>();
  private pendingPiecesPath = "";
  private previousCenters: StrokeCenter[] = [];
  private readonly pendingPieces: PressureOutlinePiece[] = [];
  private maximumPendingPieces = 0;
  private readonly committedWindows: PressureWindow[] = [];
  private readonly centerlinePaths: string[] = [];
  private tail: StrokePathGeometry | undefined;
  private tailCenters: readonly StrokeCenter[] = [];
  private completedWindows: readonly PressureWindow[] | undefined;

  constructor(private readonly style: StrokeStyleV1) {}

  finalize(points: readonly number[], first: number): StrokePathGeometry | undefined {
    const current =
      this.pendingWindows.get(first) ?? this.window(points, first, first + LIVE_STROKE_WINDOW);
    const nextStart = first + LIVE_STROKE_WINDOW;
    const next =
      this.pendingWindows.get(nextStart) ??
      this.window(points, nextStart, nextStart + LIVE_STROKE_WINDOW);
    const successors = next.slice(1, 2);
    this.pendingWindows.delete(first);
    this.pendingPaths.delete(first);
    this.pendingWindows.set(nextStart, next);
    if (this.style.pressureEnabled && !this.pendingPaths.has(nextStart))
      this.pendingPaths.set(nextStart, this.capsulePreview(next));
    let geometry: StrokePathGeometry | undefined;
    if (this.style.pressureEnabled) {
      for (const piece of this.pressurePieces(current, successors, false)) {
        this.pendingPieces.push(piece);
        this.maximumPendingPieces = Math.max(this.maximumPendingPieces, this.pendingPieces.length);
        if (this.pendingPieces.length === 64) {
          const windows = preparePressureWindows(this.pendingPieces);
          this.committedWindows.push(...windows);
          this.pendingPieces.length = 0;
          geometry = [{ d: serializePressureWindows(windows), paint: "fill" }];
        }
      }
    } else {
      const d = buildCenterline(current);
      this.centerlinePaths.push(d);
      geometry = [{ d, paint: "stroke" }];
    }
    this.pendingPiecesPath = this.style.pressureEnabled
      ? serializePressureCapsules(this.pendingPieces)
      : "";
    this.previousCenters = current.slice(-2, -1);
    return geometry;
  }

  get maximumPendingPressurePieces(): number {
    return this.maximumPendingPieces;
  }

  preview(points: readonly number[], first: number): StrokePathGeometry {
    const last = points.length / 3 - 1;
    if (last >= first + LIVE_STROKE_WINDOW + 2 && !this.pendingWindows.has(first)) {
      const selected = this.window(points, first, first + LIVE_STROKE_WINDOW);
      this.pendingWindows.set(first, selected);
      if (this.style.pressureEnabled) this.pendingPaths.set(first, this.capsulePreview(selected));
    }
    const centers: StrokeCenter[] = [];
    const paths = [this.pendingPiecesPath];
    let start = first;
    for (const [windowStart, selected] of this.pendingWindows) {
      if (windowStart !== start) break;
      centers.push(...(centers.length === 0 ? selected : selected.slice(1)));
      paths.push(this.pendingPaths.get(windowStart) ?? "");
      start += LIVE_STROKE_WINDOW;
    }
    const ending = this.window(points, start, last);
    centers.push(...(centers.length === 0 ? ending : ending.slice(1)));
    if (this.style.pressureEnabled) {
      this.tailCenters = centers;
      paths.push(this.capsulePreview(ending));
      this.tail = [{ d: paths.join(""), paint: "fill" }];
    } else {
      this.tail = [{ d: buildCenterline(centers), paint: "stroke" }];
    }
    return this.tail;
  }

  finish(): StrokePathGeometry {
    if (this.tail === undefined) throw new RangeError("A live stroke requires geometry.");
    if (this.style.pressureEnabled) {
      return [
        {
          d: serializePressureWindows(this.pressureWindows() ?? []),
          paint: "fill",
        },
      ];
    }
    const paths = [...this.centerlinePaths, this.tail[0]!.d];
    return [
      {
        d: paths
          .map((path, index) => (index === 0 ? path : path.slice(path.search(/[LQ]/))))
          .join(""),
        paint: "stroke",
      },
    ];
  }

  pressureWindows(): readonly PressureWindow[] | undefined {
    if (!this.style.pressureEnabled) return undefined;
    return (this.completedWindows ??= [
      ...this.committedWindows,
      ...preparePressureWindows([
        ...this.pendingPieces,
        ...this.pressurePieces(this.tailCenters, [], true),
      ]),
    ]);
  }

  memoryUsage(): number {
    const windows = this.committedWindows.reduce(
      (bytes, window) => bytes + pressureWindowMemoryUsage(window),
      0,
    );
    const pieces = this.pendingPieces.reduce(
      (bytes, piece) => bytes + pressureOutlinePieceMemoryUsage(piece),
      0,
    );
    const centers = [...this.pendingWindows.values()].reduce(
      (count, points) => count + points.length,
      this.previousCenters.length + this.tailCenters.length,
    );
    const paths = [
      ...this.centerlinePaths,
      ...this.pendingPaths.values(),
      this.pendingPiecesPath,
    ].reduce((bytes, path) => bytes + path.length * 2, 0);
    return windows + pieces + centers * 24 + paths + (this.tail?.[0]?.d.length ?? 0) * 2;
  }

  private capsulePreview(centers: readonly StrokeCenter[]): string {
    const pieces: PressureOutlinePiece[] = [];
    visitPreparedPressureOutline(centers, this.style.width, (piece) => {
      pieces.push(piece);
      return false;
    });
    return serializePressureCapsules(pieces);
  }

  private window(points: readonly number[], first: number, last: number): StrokeCenter[] {
    const contextFirst = Math.max(0, first - 1);
    const contextLast = Math.min(points.length / 3 - 1, last + 1);
    const centers = smoothStrokeCenters(points.slice(contextFirst * 3, (contextLast + 1) * 3));
    return simplifyStrokeCenters(
      centers.slice(first - contextFirst, last - contextFirst + 1),
      this.style.width,
      this.style.pressureEnabled,
    );
  }

  private pressurePieces(
    centers: readonly StrokeCenter[],
    successors: readonly StrokeCenter[],
    final: boolean,
  ): PressureOutlinePiece[] {
    const context = [...this.previousCenters, ...centers, ...successors];
    const firstBoundary = this.previousCenters.length === 0 ? null : this.previousCenters.length;
    const lastBoundary = final ? null : context.length - successors.length - 1;
    const pieces: PressureOutlinePiece[] = [];
    visitPreparedPressureOutline(
      context,
      this.style.width,
      (piece) => {
        pieces.push(piece);
        return false;
      },
      { firstBoundary, lastBoundary },
    );
    return pieces;
  }
}
