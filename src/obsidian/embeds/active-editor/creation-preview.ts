import { buildElementPathParts } from "../../../domain/geometry/public";
import type {
  EndpointConnectionV1,
  InkElementV1,
  PointV1,
  StrokeElementV1,
  StrokeStyleV1,
} from "../../../domain/schema/public";
import type { ToolDefaultsV1 } from "../../../domain/settings/types";
import type { GesturePreview, GesturePreviewStart } from "../../../editor/gestures/public";
import { resolvePointAngleSnap } from "../../../editor/selection/public";
import {
  findSnapCandidate,
  SnapCandidateScratch,
  type SnapCandidate,
  type SnapTargetReader,
  type SpatialCandidateQuery,
} from "../../../editor/snapping/snap-candidate";
import { LiveStrokeBuilder, type LiveStrokeCommit } from "../../../editor/tools/live-stroke";
import { createDragElement, createFreehandElement } from "../../../editor/tools/public";
import { pathPresentation } from "../../../rendering/scene/element-presentation";
import type { LivePathState } from "../../../rendering/scene/index";

import type { CoalescedCreationSample, CoalescedFrameSampleMode } from "./coalesced-input";
import type { ActiveEditorHistory } from "./history";
import { selectionSnapGuidePath, snapMarkerPath } from "./snap-marker-path";

export interface CreationPreviewRenderer {
  clearLiveStroke(): void;
  commitLiveStroke(id: string, prepared?: LiveStrokeCommit): void;
  commitLivePath(id: string): void;
  setLivePath(path: LivePathState | null): void;
  setSnapMarkerPath(d: string | null): void;
  suppressMotionForNextDelta(ids: readonly string[]): void;
  updateLiveStroke(
    preview: ReturnType<LiveStrokeBuilder["preview"]>,
    style: StrokeStyleV1,
    tool: StrokeElementV1["tool"],
  ): void;
}

export interface CreationSnapPorts {
  readonly angles?: boolean | (() => boolean);
  readonly connections?: boolean | (() => boolean);
  readonly pageToScreen: (point: PointV1) => PointV1;
  readonly spatial: SpatialCandidateQuery;
  readonly targets: SnapTargetReader;
  readonly zoom: number;
}

export interface CreationPreviewOptions {
  readonly defaults: ToolDefaultsV1;
  readonly now?: () => number;
  readonly onStrokeCapacityReached?: () => void;
  readonly history: ActiveEditorHistory;
  readonly identity: { readonly createdAt: number; readonly id: string };
  readonly renderer: CreationPreviewRenderer;
  readonly snap?: CreationSnapPorts;
  readonly strokeInput?: { readonly pressureSource: "pen" | "simulated"; readonly zoom: number };
  readonly start: GesturePreviewStart;
}

export class CreationPreview implements GesturePreview {
  readonly #defaults: ToolDefaultsV1;
  readonly #now: (() => number) | undefined;
  readonly #onStrokeCapacityReached: (() => void) | undefined;
  readonly #history: ActiveEditorHistory;
  readonly #identity: CreationPreviewOptions["identity"];
  readonly #renderer: CreationPreviewRenderer;
  readonly #snapScratch = new SnapCandidateScratch();
  readonly #snap: CreationSnapPorts | undefined;
  readonly #stroke: LiveStrokeBuilder | null;
  #strokeCommit: LiveStrokeCommit | undefined;
  readonly #strokePressureSource: "pen" | "simulated";
  readonly #strokeStyle: StrokeStyleV1 | null;
  readonly #start: GesturePreviewStart;
  #current: GesturePreviewStart["pointer"];
  #endAngleSnap: PointV1 | null = null;
  #endSnap: SnapCandidate | null = null;
  #finished = false;
  #sampleTime = 0;
  #startSnap: SnapCandidate | null = null;
  #startSnapResolved = false;

  public get frameSampleMode(): CoalescedFrameSampleMode {
    return this.#stroke === null ? "latest" : "preserve";
  }

  public constructor(options: CreationPreviewOptions) {
    this.#defaults = options.defaults;
    this.#now = options.now;
    this.#onStrokeCapacityReached = options.onStrokeCapacityReached;
    this.#sampleTime = this.#now?.() ?? 0;
    this.#history = options.history;
    this.#identity = options.identity;
    this.#renderer = options.renderer;
    this.#snap = options.snap;
    this.#start = options.start;
    this.#current = options.start.pointer;
    this.#strokeStyle = isFreehand(this.#start.tool)
      ? strokeStyle(this.#defaults, this.#start.tool)
      : null;
    this.#strokePressureSource =
      options.strokeInput?.pressureSource ??
      (this.#start.tool === "draw" && this.#start.pointer.pointerType === "pen"
        ? "pen"
        : "simulated");
    this.#stroke =
      this.#strokeStyle === null
        ? null
        : new LiveStrokeBuilder({
            input: options.strokeInput ?? {
              pressureSource: this.#strokePressureSource,
              zoom: 1,
            },
            style: this.#strokeStyle,
          });
    this.#appendSample(options.start.pointer, this.#sampleTime);
    this.#updateSnapCandidates();
    this.#render();
  }

  public commit(): boolean {
    this.#assertActive();
    const element = this.#commitElement();
    this.#finished = true;
    this.#renderer.setSnapMarkerPath(null);
    this.#renderer.suppressMotionForNextDelta([element.id]);
    const retainPath = this.#start.tool === "straight-highlighter";
    if (this.#stroke === null && !retainPath) this.#renderer.setLivePath(null);
    try {
      const committed = this.#history.create([element]);
      if (this.#stroke !== null && committed)
        this.#renderer.commitLiveStroke(element.id, this.#strokeCommit);
      else if (this.#stroke !== null) this.#renderer.clearLiveStroke();
      if (retainPath) {
        if (committed) this.#renderer.commitLivePath(element.id);
        else this.#renderer.setLivePath(null);
      }
      return committed;
    } catch (error) {
      if (retainPath) this.#renderer.setLivePath(null);
      if (this.#stroke !== null) this.#renderer.clearLiveStroke();
      throw error;
    }
  }

  public revert(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#renderer.setSnapMarkerPath(null);
    if (this.#stroke === null) this.#renderer.setLivePath(null);
    else this.#renderer.clearLiveStroke();
  }

  public update(pointer: GesturePreviewStart["pointer"]): void {
    this.updateSamples([{ ...pointer, time: this.#nextSampleTime() }]);
  }

  public updateSamples(samples: readonly CoalescedCreationSample[]): void {
    this.#assertActive();
    const current = samples[samples.length - 1];
    if (current === undefined) return;
    this.#current = current;
    if (this.#stroke === null) this.#sampleTime = Math.max(this.#sampleTime, current.time);
    else {
      const exhausted = this.#stroke.capacityExhausted;
      this.#stroke.appendBatch(
        samples.map((sample) => ({
          pressure: inputPressure(sample.pressure, this.#strokePressureSource),
          time: sample.time,
          x: sample.x,
          y: sample.y,
        })),
      );
      this.#sampleTime = Math.max(this.#sampleTime, current.time);
      if (exhausted) return;
      if (this.#stroke.capacityExhausted) this.#onStrokeCapacityReached?.();
    }
    this.#updateSnapCandidates();
    this.#render();
  }

  #appendSample(pointer: GesturePreviewStart["pointer"], time: number): void {
    this.#stroke?.append({
      x: pointer.x,
      y: pointer.y,
      pressure: inputPressure(pointer.pressure, this.#strokePressureSource),
      time,
    });
    this.#sampleTime = Math.max(this.#sampleTime, time);
  }

  #assertActive(): void {
    if (this.#finished) throw new Error("A completed creation preview cannot be updated.");
  }

  #commitElement(): InkElementV1 {
    if (isFreehand(this.#start.tool)) {
      if (this.#stroke === null) throw new Error("Freehand creation requires a live stroke.");
      const commit = this.#stroke.finish();
      this.#strokeCommit = commit;
      return createFreehandElement({
        defaults: this.#defaults,
        identity: this.#identity,
        samples: commit.points,
        tool: this.#start.tool,
      });
    }
    return this.#createDragElement();
  }

  #render(): void {
    if (this.#stroke !== null && this.#strokeStyle !== null) {
      this.#renderer.updateLiveStroke(
        this.#stroke.preview(),
        this.#strokeStyle,
        this.#start.tool === "highlighter" ? "highlighter" : "pen",
      );
      return;
    }
    const element = this.#commitElementWithoutFinishing();
    const parts = buildElementPathParts(element);
    this.#renderer.setLivePath({
      band: this.#start.tool === "straight-highlighter" ? "highlight" : "content",
      parts: parts.map((part) => ({
        d: part.d,
        presentation: pathPresentation(element, part),
      })),
    });
    this.#renderSnapMarkers();
  }

  #commitElementWithoutFinishing(): InkElementV1 {
    return this.#createDragElement();
  }

  #createDragElement(): InkElementV1 {
    const tool = this.#start.tool;
    if (isFreehand(tool) || tool === "select" || tool === "eraser") {
      throw new TypeError(`${tool} is not a drag creation tool.`);
    }
    const start = this.#startSnap?.point ?? this.#start.pointer;
    const end = this.#dragEnd(start, tool);
    return createDragElement({
      defaults: this.#defaults,
      end,
      endConnection: snapConnection(this.#endSnap),
      identity: this.#identity,
      start,
      startConnection: snapConnection(this.#startSnap),
      tool,
    });
  }

  #dragEnd(start: PointV1, tool: GesturePreviewStart["tool"]): PointV1 {
    this.#endAngleSnap = null;
    if (this.#endSnap !== null || !supportsAngleSnapping(tool)) {
      return this.#endSnap?.point ?? this.#current;
    }
    if (!this.#snapFeatureEnabled("angles")) return this.#current;
    const result = resolvePointAngleSnap({
      origin: start,
      point: this.#current,
      snapPixels: 5,
      stepDegrees: 90,
      zoom: this.#snap?.zoom ?? 1,
    });
    if (result.snapped) this.#endAngleSnap = result.point;
    return result.point;
  }

  #renderSnapMarkers(): void {
    if (this.#snap === undefined || !supportsAngleSnapping(this.#start.tool)) {
      this.#renderer.setSnapMarkerPath(null);
      return;
    }
    const points = [this.#startSnap?.point, this.#endSnap?.point].filter(
      (point): point is PointV1 => point !== undefined,
    );
    const markers = points.map((point) => snapMarkerPath(this.#snap!.pageToScreen(point)));
    if (this.#endAngleSnap !== null && this.#endSnap === null) {
      markers.push(
        selectionSnapGuidePath(
          {
            end: this.#endAngleSnap,
            kind: "angular",
            start: this.#startSnap?.point ?? this.#start.pointer,
          },
          this.#snap.pageToScreen,
        ),
      );
    }
    const path = markers.join(" ");
    this.#renderer.setSnapMarkerPath(path.length === 0 ? null : path);
  }

  #updateSnapCandidates(): void {
    const snap = this.#snap;
    if (
      snap === undefined ||
      !this.#snapFeatureEnabled("connections") ||
      !supportsConnections(this.#start.tool)
    ) {
      this.#startSnap = null;
      this.#endSnap = null;
      this.#startSnapResolved = false;
      return;
    }
    if (!this.#startSnapResolved) {
      this.#startSnap = findSnapCandidate(
        {
          current: null,
          pointer: this.#start.pointer,
          pointerType: this.#start.pointer.pointerType,
          zoom: snap.zoom,
        },
        snap.spatial,
        snap.targets,
        this.#snapScratch,
      );
      this.#startSnapResolved = true;
    }
    const candidate = findSnapCandidate(
      {
        current: this.#endSnap,
        pointer: this.#current,
        pointerType: this.#start.pointer.pointerType,
        zoom: snap.zoom,
      },
      snap.spatial,
      snap.targets,
      this.#snapScratch,
    );
    this.#endSnap = candidate;
  }

  #snapFeatureEnabled(feature: "angles" | "connections"): boolean {
    const configured = this.#snap?.[feature];
    return typeof configured === "function" ? configured() : (configured ?? true);
  }

  #nextSampleTime(): number {
    this.#sampleTime = this.#now?.() ?? this.#sampleTime + 1;
    return this.#sampleTime;
  }
}

function snapConnection(candidate: SnapCandidate | null): EndpointConnectionV1 | null {
  return candidate === null ? null : { anchor: candidate.anchor, targetId: candidate.targetId };
}

function supportsConnections(tool: GesturePreviewStart["tool"]): tool is "arrow" | "line" {
  return tool === "line" || tool === "arrow";
}

function supportsAngleSnapping(tool: GesturePreviewStart["tool"]): boolean {
  return supportsConnections(tool) || tool === "straight-highlighter";
}

function isFreehand(tool: GesturePreviewStart["tool"]): tool is "draw" | "highlighter" {
  return tool === "draw" || tool === "highlighter";
}

function inputPressure(pressure: number | undefined, source: "pen" | "simulated"): number {
  if (source === "simulated") return 0.5;
  if (pressure === undefined) return 0.5;
  if (!Number.isFinite(pressure)) throw new RangeError("Pen pressure must be finite.");
  return Math.min(1, Math.max(0, pressure));
}

function strokeStyle(defaults: ToolDefaultsV1, tool: "draw" | "highlighter"): StrokeStyleV1 {
  const source = tool === "draw" ? defaults.pen : defaults.highlighter;
  return {
    color: structuredClone(source.color),
    opacity: source.opacity,
    pressureEnabled: tool === "draw" ? defaults.pen.pressureEnabled : false,
    smoothing: 0.5,
    width: source.width,
  };
}
