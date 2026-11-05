import type {
  EndpointConnectionV1,
  InkElementV1,
  PointV1,
  StrokeStyleV1,
} from "../../../../domain/schema/public";
import type { ToolDefaultsV1 } from "../../../../domain/settings/types";
import type { GesturePreview, GesturePreviewStart } from "../../../../editor/gestures/public";
import { resolvePointAngleSnap } from "../../../../editor/selection/public";
import { type SnapCandidate } from "../../../../editor/snapping/snap-candidate";
import { LiveStrokeBuilder, type LiveStrokeCommit } from "../../../../editor/tools/live-stroke";
import { createDragElement, createFreehandElement } from "../../../../editor/tools/public";
import type { LivePathState } from "../../../../rendering/scene/index";

import type { CoalescedCreationSample, CoalescedFrameSampleMode } from "../input/coalesced-input";
import type { ActiveEditorHistory, RefinableElementCreate } from "../history";
import type { EditableDocumentModel } from "../../document-session/document-model-port";
import type { ElementRecord } from "../../../../domain/store/types";
import { selectionSnapGuidePath, snapMarkerPath } from "./snap-marker-path";
import { CreationSnapping, type CreationSnapPorts } from "./creation-snapping";
import {
  type CreationHoldRecognition,
  connectRecognizedElement,
  createCreationHold,
  creationHoldSnapEndpoints,
} from "./creation-hold-recognition";
import { creationLivePath } from "./creation-path";
import { inputPressure, strokeStyle } from "./creation-stroke-input";
import type { CreationPreviewOptions, CreationPreviewRenderer } from "./creation-preview-types";
export type { CreationPreviewOptions, CreationPreviewRenderer } from "./creation-preview-types";
export type { CreationSnapPorts } from "./creation-snapping";

export class CreationPreview implements GesturePreview {
  readonly #hold: CreationHoldRecognition | undefined;
  readonly #defaults: ToolDefaultsV1;
  readonly #now: (() => number) | undefined;
  readonly #onStrokeCapacityReached: (() => void) | undefined;
  readonly #history: ActiveEditorHistory;
  readonly #identity: CreationPreviewOptions["identity"];
  readonly #renderer: CreationPreviewRenderer;
  readonly #snapping: CreationSnapping | undefined;
  readonly #isCurrent: () => boolean;
  #completion: Promise<boolean> | undefined;
  readonly #model: EditableDocumentModel | undefined;
  readonly #refinementSignal: AbortSignal | undefined;
  #refinementFence: number | undefined;
  #cancelled = false;
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
  #recognized: InkElementV1 | null = null;
  #holdStartPreview = true;
  #connectionsEnabled: boolean | undefined;

  public get frameSampleMode(): CoalescedFrameSampleMode {
    return this.#stroke === null ? "latest" : "preserve";
  }

  public constructor(options: CreationPreviewOptions) {
    this.#defaults = options.defaults;
    this.#now = options.now;
    this.#onStrokeCapacityReached = options.onStrokeCapacityReached;
    this.#sampleTime = this.#now?.() ?? 0;
    this.#history = options.history;
    this.#model = options.model;
    this.#refinementSignal = options.refinementSignal;
    this.#identity = options.identity;
    this.#renderer = options.renderer;
    this.#snap = options.snap;
    this.#isCurrent = () => !options.history.isDisposed && (options.isCurrent?.() ?? true);
    if (options.snap !== undefined) {
      this.#snapping = new CreationSnapping({
        snap: {
          ...options.snap,
          targets: {
            get: (id, bounds) => {
              if (id === options.identity.id) return null;
              if (this.#refinementFence !== undefined) {
                const version = this.#model?.store.get(id)?.geometryVersion;
                if (version === undefined || version >= this.#refinementFence) return null;
              }
              return options.snap!.targets.get(id, bounds);
            },
          },
        },
        ...(options.workScheduler === undefined ? {} : { scheduler: options.workScheduler }),
        start: options.start.pointer,
        readRevision: options.readRevision ?? (() => 0),
        isCurrent: () => !this.#cancelled && this.#isCurrent(),
        onReady: () => this.#snapReady(),
      });
    }
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
            tool: this.#start.tool === "highlighter" ? "highlighter" : "pen",
            input: options.strokeInput ?? {
              pressureSource: this.#strokePressureSource,
              zoom: 1,
            },
            style: this.#strokeStyle,
          });
    this.#appendSample(options.start.pointer, this.#sampleTime);
    this.#hold = createCreationHold(
      options,
      () => this.#stroke!.samples,
      () => !this.#finished && this.#isCurrent(),
      (element) => {
        if (this.#finished) return;
        this.#recognized = element;
        if (element === null) this.#holdStartPreview = false;
        this.#updateSnapCandidates(false, true);
      },
    );
    this.#updateSnapCandidates(true);
    this.#render();
  }

  public commit(): boolean {
    this.#assertActive();
    if (!this.#isCurrent()) {
      this.revert();
      return false;
    }
    if (this.#stroke === null || this.#recognized !== null) {
      this.#updateSnapCandidates(this.#stroke === null);
    } else this.#snapping?.cancel();
    if (this.#snapping?.pending) {
      return this.#commitPendingSnap();
    }
    const committed = this.#commitNow();
    this.#completion = Promise.resolve(committed);
    return committed;
  }

  public get completion(): Promise<boolean> {
    return this.#completion ?? Promise.resolve(false);
  }

  #commitNow(): boolean {
    if (this.#cancelled || !this.#isCurrent()) return false;
    const recognized = this.#recognized;
    const element = this.#commitElement();
    this.#finished = true;
    this.#hold?.dispose();
    this.#renderer.setSnapMarkerPath(null);
    this.#renderer.suppressMotionForNextDelta([element.id]);
    const retainPath = this.#start.tool === "straight-highlighter" || recognized !== null;
    if (recognized !== null) this.#renderer.setLivePath(this.#elementPath(element));
    if (this.#stroke === null && !retainPath) this.#renderer.setLivePath(null);
    try {
      const committed = this.#history.create([element]);
      if (this.#stroke !== null && committed && recognized === null)
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
    this.#snapping?.cancel();
    this.#hold?.dispose();
    this.#cancelled = true;
    if (this.#finished) return;
    this.#finished = true;
    this.#renderer.setSnapMarkerPath(null);
    this.#renderer.setLivePath(null);
    if (this.#stroke !== null) this.#renderer.clearLiveStroke();
  }

  public update(pointer: GesturePreviewStart["pointer"]): void {
    this.updateSamples([{ ...pointer, time: this.#nextSampleTime() }]);
  }

  /** Observes validated screen samples before frame coalescing can hide an excursion. */
  public observeInputSamples(samples: readonly PointV1[]): void {
    this.#hold?.observe(samples);
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
    if (this.#recognized !== null)
      return connectRecognizedElement(this.#recognized, [this.#startSnap, this.#endSnap]);
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
    this.#renderer.setLivePath(this.#elementPath(this.#commitElementWithoutFinishing()));
    this.#renderSnapMarkers();
  }

  #elementPath(element: InkElementV1): LivePathState {
    return creationLivePath(element);
  }

  #renderHold(): void {
    this.#renderer.setLivePath(
      this.#recognized === null ? null : creationLivePath(this.#commitElement(), 0.3),
    );
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
    if (
      this.#snap === undefined ||
      (!supportsAngleSnapping(this.#start.tool) && this.#hold === undefined)
    ) {
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

  #updateSnapCandidates(revalidate = false, candidateChanged = false): void {
    const enabled = this.#snapFeatureEnabled("connections");
    if (
      this.#hold !== undefined &&
      !revalidate &&
      !candidateChanged &&
      enabled === this.#connectionsEnabled &&
      !this.#snapping?.needsRevalidation
    )
      return;
    this.#connectionsEnabled = enabled;
    const hold =
      this.#hold === undefined
        ? undefined
        : creationHoldSnapEndpoints(
            this.#recognized,
            this.#start.pointer,
            this.#current,
            this.#holdStartPreview,
          );
    this.#snapping?.update(
      hold?.end ?? this.#current,
      enabled && (supportsConnections(this.#start.tool) || hold?.enabled === true),
      revalidate,
      hold,
    );
    this.#readSnapCandidates();
    if (this.#hold !== undefined && !this.#finished) this.#renderHold();
  }

  #readSnapCandidates(): void {
    this.#startSnap = this.#snapping?.start ?? null;
    this.#endSnap = this.#snapping?.end ?? null;
  }

  #snapReady(): void {
    if (this.#finished) return;
    this.#readSnapCandidates();
    if (this.#stroke === null) this.#render();
    else this.#renderHold();
  }

  #commitPendingSnap(): boolean {
    const element = this.#commitElement();
    this.#finished = true;
    this.#hold?.dispose();
    this.#renderer.setSnapMarkerPath(null);
    this.#renderer.setLivePath(this.#elementPath(element));
    this.#renderer.suppressMotionForNextDelta([element.id]);
    let retained: RefinableElementCreate | null;
    try {
      retained = this.#history.createRefinable(element, () => {
        this.#cancelled = true;
        this.#snapping?.cancel();
      });
    } catch (error) {
      this.#snapping?.cancel();
      this.#renderer.setLivePath(null);
      if (this.#stroke !== null) this.#renderer.clearLiveStroke();
      throw error;
    }
    if (retained === null) {
      this.#snapping?.cancel();
      this.#renderer.setLivePath(null);
      if (this.#stroke !== null) this.#renderer.clearLiveStroke();
      return false;
    }
    this.#renderer.commitLivePath(element.id);
    if (this.#stroke !== null) this.#renderer.clearLiveStroke();
    const original = this.#model?.store.get(element.id);
    if (original === undefined) {
      retained.finish();
      this.#snapping?.cancel();
      this.#completion = Promise.resolve(false);
    } else {
      this.#refinementFence = original.geometryVersion;
      this.#updateSnapCandidates(true);
      this.#completion = this.#refineSnap(retained, original);
    }
    return true;
  }

  async #refineSnap(retained: RefinableElementCreate, original: ElementRecord): Promise<boolean> {
    const model = this.#model!;
    const release = model.beginInteractiveOperation?.();
    const signal = this.#refinementSignal;
    const abort = () => {
      this.#cancelled = true;
      this.#snapping?.cancel();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const cancelled = () =>
      this.#cancelled ||
      !this.#isCurrent() ||
      model.store.get(original.element.id) !== original ||
      !model.store.beginDependents(original.element.id).next().done;
    try {
      if (cancelled() || !(await this.#snapping!.settle())) return false;
      this.#startSnap = this.#snapping!.start;
      this.#endSnap = this.#snapping!.end;
      const element = this.#commitElement();
      if (cancelled() || !retained.canRefine(element)) return false;
      const prepared = await model.prepareElementReplacement([element], { isCancelled: cancelled });
      if (prepared.token === null || cancelled() || !retained.canRefine(element)) return false;
      const status = model.commitPreparedElementReplacement(prepared.token);
      if (status !== "committed" && status !== "noop") return false;
      return retained.acceptRefinement(element);
    } catch {
      return false;
    } finally {
      signal?.removeEventListener("abort", abort);
      retained.finish();
      this.#snapping?.cancel();
      release?.();
    }
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
