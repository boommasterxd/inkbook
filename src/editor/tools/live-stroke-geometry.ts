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
} from "../../domain/geometry/pressure/pressure-outline";
import {
  preparePressureWindows,
  serializePressureWindows,
  serializePressureCapsules,
  pressureWindowMemoryUsage,
  pressureOutlinePieceMemoryUsage,
  type PressureWindow,
} from "../../domain/geometry/pressure/pressure-path-serialization";
import {
  tryPrepareLivePressureWindow,
  completeLivePressureWindow,
  type LivePressureWindowPreparation,
} from "../../domain/geometry/pressure/pressure-window";
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
  private deferredGeometryPreparation = false;
  private commitWindows: LivePressureWindowPreparation[] | undefined;

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
          const prepared = tryPrepareLivePressureWindow(this.pendingPieces);
          const window = prepared === undefined ? undefined : completeLivePressureWindow(prepared);
          if (window === undefined) {
            this.deferredGeometryPreparation = true;
            this.committedWindows.length = 0;
          } else if (!this.deferredGeometryPreparation) this.committedWindows.push(window);
          geometry = [
            {
              d:
                window === undefined
                  ? serializePressureCapsules(this.pendingPieces)
                  : serializePressureWindows([window]),
              paint: "fill",
            },
          ];
          this.pendingPieces.length = 0;
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

  prepareCommit(): boolean {
    if (!this.style.pressureEnabled || this.deferredGeometryPreparation)
      return this.deferredGeometryPreparation;
    const pieces = [...this.pendingPieces, ...this.pressurePieces(this.tailCenters, [], true)];
    const prepared: LivePressureWindowPreparation[] = [];
    for (let start = 0; start < pieces.length; start += 64) {
      const window = tryPrepareLivePressureWindow(pieces.slice(start, start + 64));
      if (window === undefined) {
        this.deferredGeometryPreparation = true;
        this.committedWindows.length = 0;
        return true;
      }
      prepared.push(window);
    }
    this.commitWindows = prepared;
    return false;
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

  finish(points: readonly number[]): StrokePathGeometry {
    if (this.tail === undefined) throw new RangeError("A live stroke requires geometry.");
    if (this.style.pressureEnabled) {
      return [
        {
          d: serializePressureWindows(this.pressureWindows(points) ?? []),
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

  pressureWindows(points: readonly number[]): readonly PressureWindow[] | undefined {
    if (!this.style.pressureEnabled) return undefined;
    if (this.deferredGeometryPreparation) {
      return (this.completedWindows ??= this.prepareDeferredWindows(points));
    }
    if (this.completedWindows !== undefined) return this.completedWindows;
    const tail = (this.commitWindows ?? []).map(completeLivePressureWindow);
    this.commitWindows = undefined;
    return (this.completedWindows = [...this.committedWindows, ...tail]);
  }

  private prepareDeferredWindows(points: readonly number[]): readonly PressureWindow[] {
    const centers = simplifyStrokeCenters(smoothStrokeCenters(points), this.style.width, true);
    const pieces: PressureOutlinePiece[] = [];
    visitPreparedPressureOutline(centers, this.style.width, (piece) => {
      pieces.push(piece);
      return false;
    });
    return preparePressureWindows(pieces);
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
    const commit = (this.commitWindows ?? []).reduce(
      (bytes, window) =>
        bytes +
        pressureWindowMemoryUsage({ kind: "path-window", loops: window.union.contours }) +
        window.pieces.reduce((total, piece) => total + pressureOutlinePieceMemoryUsage(piece), 0),
      0,
    );
    return windows + pieces + commit + centers * 24 + paths + (this.tail?.[0]?.d.length ?? 0) * 2;
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
