import type { InkElementV1, PointV1 } from "../../domain/schema/public";
import {
  findSnapCandidate,
  SnapCandidateScratch,
  type SnapCandidate,
} from "../snapping/snap-candidate";
import type {
  SelectionCommitPreparation,
  SelectionHandleAction,
  SelectionHandlePreview,
  SelectionHandleSessionOptions,
  SelectionHandleUpdateOptions,
  SelectionPreviewTransform,
  SelectionSnapGuide,
  SelectionSnapPorts,
  TimeSlicedSelectionCommitPreparation,
} from "./handle-types";
import {
  selectionHandleSnapGuide,
  selectionRotationDelta,
} from "./transform/handle-snap-resolution";
import { assertFiniteHandlePoint } from "./transform/handle-session-validation";
import { SelectionScaleGesture } from "./transform/selection-scale";
import { selectionSnapFeatureEnabled } from "./transform/snap-features";
import {
  moveSelection,
  rotateSelection,
  type ScaleFactors,
  type TransformSliceScheduler,
} from "./transform/transforms";
import { materializeTargetedHandle } from "./transform/targeted-handle-action";
import {
  exceedsExactPreviewWork,
  exceedsReplacementWork,
  type SelectionReplacementPlanner,
  type ReplacementWorkOptions,
} from "./selection-work-budget";

export type { SelectionReplacementPlanner } from "./selection-work-budget";
export type {
  SelectionCommitPreparation,
  SelectionHandleAction,
  SelectionHandlePreview,
  SelectionHandleSessionOptions,
  SelectionPreviewTransform,
  SelectionSnapGuide,
  SelectionSnapPorts,
  TimeSlicedSelectionCommitPreparation,
} from "./handle-types";

const SYNCHRONOUS_SELECTION_LIMIT = 1_000;
const SYNCHRONOUS_SELECTION_WORK_LIMIT = 16_384;
const DEFAULT_REPLACEMENT_WORK = Object.freeze({ includeReverseDependencies: true });
const MOVE_REPLACEMENT_WORK = Object.freeze({
  includeReverseDependencies: true,
  countStrokeSamples: false,
});
const TABLE_SEPARATOR_REPLACEMENT_WORK = Object.freeze({ includeReverseDependencies: false });

export class SelectionHandleSession {
  readonly #affineScalePreview: boolean;
  readonly #action: SelectionHandleAction;
  readonly #elements: readonly InkElementV1[];
  readonly #planner: SelectionReplacementPlanner;
  readonly #scale: SelectionScaleGesture | undefined;
  readonly #snapScratch = new SnapCandidateScratch();
  readonly #snap: SelectionSnapPorts | undefined;
  #snapFeatures: SelectionSnapPorts["features"];
  readonly #startPointer: PointV1;
  #cancelled = false;
  #currentPointer: PointV1;
  #generation = 0;
  #preview: SelectionHandlePreview;
  #snapCandidate: SnapCandidate | null = null;
  #uniformScale = false;
  #valid = true;

  public constructor(options: SelectionHandleSessionOptions) {
    if (options.elements.length === 0) throw new RangeError("A handle session needs a selection.");
    assertFiniteHandlePoint(options.startPointer);
    this.#affineScalePreview =
      options.action.kind === "scale" && options.elements.some(({ kind }) => kind === "stroke");
    this.#action = options.action;
    this.#elements = options.elements;
    this.#planner = options.planner;
    this.#scale =
      options.action.kind === "scale"
        ? new SelectionScaleGesture(
            options.action,
            options.elements,
            options.startPointer,
            options.preparedFrame,
          )
        : undefined;
    this.#snap = options.snap;
    this.#snapFeatures = options.snap?.features;
    this.#startPointer = options.startPointer;
    this.#currentPointer = options.startPointer;
    if (options.uniformScale !== undefined) this.#uniformScale = options.uniformScale;
    this.#assertActionTarget();
    this.#preview = this.#emptyPreview();
  }

  public get preview(): SelectionHandlePreview {
    return this.#preview;
  }

  public createScalePreviewMaterializer(): ((element: InkElementV1) => InkElementV1) | undefined {
    const scale = this.#scale;
    const transform = this.#preview.transform;
    if (scale === undefined || transform?.kind !== "scale") return undefined;
    const pointer = this.#currentPointer;
    const uniform = this.#uniformScale;
    const factors = scale.factorsAt(pointer, uniform);
    const delta = transform.delta;
    return (element) =>
      moveSelection([scale.materializeOne(element, pointer, uniform, factors)], delta)[0]!;
  }

  public cancel(): void {
    this.#cancelled = true;
    this.#generation += 1;
    this.#snapCandidate = null;
    this.#preview = this.#emptyPreview();
  }

  public update(
    pointer: PointV1,
    options: SelectionHandleUpdateOptions = {},
  ): SelectionHandlePreview {
    this.#assertActive();
    assertFiniteHandlePoint(pointer);
    this.#currentPointer = pointer;
    if (options.uniformScale !== undefined) this.#uniformScale = options.uniformScale;
    if (options.snapFeatures !== undefined) this.#snapFeatures = options.snapFeatures;
    this.#generation += 1;
    this.#updateSnapCandidate();
    this.#preview = this.#createPreview();
    return this.#preview;
  }

  public prepareCommit(): SelectionCommitPreparation {
    this.#assertActive();
    if (!this.#hasChanged() || !this.#valid) return { status: "noop" };
    if (this.#requiresTimeSlicedCommit()) {
      return { status: "time-sliced-required" };
    }
    try {
      const plan = this.#planner.planReplacements(this.#materializeDirect());
      if (plan === null) return { status: "noop" };
      return { previous: this.#elements, replacements: plan.replacements, status: "ready" };
    } catch (error: unknown) {
      if (this.#affineScalePreview && error instanceof RangeError) return { status: "noop" };
      throw error;
    }
  }

  public async prepareCommitTimeSliced(
    scheduler: TransformSliceScheduler,
  ): Promise<TimeSlicedSelectionCommitPreparation> {
    this.#assertActive();
    if (!this.#hasChanged() || !this.#valid) return { status: "noop" };
    const generation = this.#generation;
    const pointer = this.#currentPointer;
    const materialized = await this.#materializeTimeSliced(scheduler, generation, pointer);
    if (materialized === null) return { status: "cancelled" };
    // The model prepares and validates one version-bound transaction before adoption.
    // Replanning here would repeat sample validation and connection propagation.
    return { previous: this.#elements, replacements: materialized, status: "ready" };
  }

  #createPreview(): SelectionHandlePreview {
    if (!this.#hasChanged()) return this.#emptyPreview();
    if (
      this.#affineScalePreview ||
      exceedsExactPreviewWork(this.#elements, this.#planner, this.#replacementWorkOptions())
    ) {
      this.#valid = true;
      const transform = this.#previewTransform(true);
      return {
        exactElements:
          this.#action.kind === "linear-endpoint" || this.#action.kind === "linear-bend"
            ? this.#replaceActionTarget()
            : [],
        exactPreviewTruncated: true,
        previewFrame: this.#previewFrame(),
        snapCandidate: this.#snapCandidate,
        snapGuide: this.#snapGuide(),
        transform,
      };
    }
    try {
      const planned = this.#planner.planReplacements(this.#materializeDirect());
      const transform = this.#previewTransform(false);
      this.#valid = planned !== null;
      return {
        exactElements: planned?.elements ?? [],
        exactPreviewTruncated: false,
        previewFrame: this.#previewFrame(),
        snapCandidate: this.#snapCandidate,
        snapGuide: this.#snapGuide(),
        transform,
      };
    } catch (error: unknown) {
      if (!(error instanceof RangeError)) throw error;
      this.#valid = false;
      return {
        exactElements: [],
        exactPreviewTruncated: false,
        previewFrame: null,
        snapCandidate: null,
        snapGuide: null,
        transform: null,
      };
    }
  }

  #materializeDirect(): InkElementV1[] {
    switch (this.#action.kind) {
      case "move":
        return moveSelection(this.#elements, this.#translation());
      case "scale":
        return this.#requiredScale().materialize(this.#currentPointer, this.#uniformScale);
      case "rotate":
        return rotateSelection(
          this.#elements,
          this.#action.center,
          this.#rotationDeltaAt(this.#currentPointer),
        );
      default:
        return this.#replaceActionTarget();
    }
  }

  async #materializeTimeSliced(
    scheduler: TransformSliceScheduler,
    generation: number,
    pointer: PointV1,
  ): Promise<InkElementV1[] | null> {
    const scaleFactors = await this.#timeSlicedScaleFactors(scheduler, generation, pointer);
    if (scaleFactors === null) return null;
    const replacements: InkElementV1[] = [];
    for (const element of this.#elements) {
      if (this.#preparationCancelled(scheduler, generation)) return null;
      replacements.push(this.#materializeOne(element, scaleFactors, pointer));
      if (this.#preparationCancelled(scheduler, generation)) return null;
      if (scheduler.shouldYield()) {
        await scheduler.yieldControl();
        if (this.#preparationCancelled(scheduler, generation)) return null;
      }
    }
    if (this.#preparationCancelled(scheduler, generation)) return null;
    if (this.#action.kind !== "scale") return replacements;
    return this.#requiredScale().stabilizeAnchorTimeSliced(replacements, {
      isCancelled: () => this.#preparationCancelled(scheduler, generation),
      shouldYield: scheduler.shouldYield,
      yieldControl: scheduler.yieldControl,
    });
  }

  #materializeOne(
    element: InkElementV1,
    scaleFactors: ScaleFactors | undefined,
    pointer: PointV1,
  ): InkElementV1 {
    if (this.#action.kind === "move") {
      return moveSelection([element], this.#translationAt(pointer))[0]!;
    }
    if (this.#action.kind === "rotate") {
      return rotateSelection([element], this.#action.center, this.#rotationDeltaAt(pointer))[0]!;
    }
    if (this.#action.kind === "scale") {
      return this.#requiredScale().materializeOne(
        element,
        pointer,
        this.#uniformScale,
        scaleFactors,
      );
    }
    return this.#replaceActionTargetAt(pointer)[0]!;
  }

  async #timeSlicedScaleFactors(
    scheduler: TransformSliceScheduler,
    generation: number,
    pointer: PointV1,
  ): Promise<ScaleFactors | null | undefined> {
    if (this.#action.kind !== "scale" || this.#elements.length === 1) return undefined;
    const factors = this.#requiredScale().factorsAt(pointer, this.#uniformScale);
    if (this.#preparationCancelled(scheduler, generation)) return null;
    return factors;
  }

  #replaceActionTarget(): InkElementV1[] {
    return this.#replaceActionTargetAt(this.#currentPointer);
  }

  #replaceActionTargetAt(pointer: PointV1): InkElementV1[] {
    const action = this.#action;
    if (!("elementId" in action)) throw new Error("Expected a targeted handle action.");
    const element = this.#targetElement(action.elementId);
    const candidate = action.kind === "linear-endpoint" ? this.#snapCandidate : null;
    return [
      materializeTargetedHandle({
        action,
        candidate,
        element,
        pointer,
        snap: this.#currentSnap(),
      }),
    ];
  }

  #requiredScale(): SelectionScaleGesture {
    if (this.#scale === undefined) throw new Error("Expected a scale action.");
    return this.#scale;
  }

  #updateSnapCandidate(): void {
    const snap = this.#currentSnap();
    if (
      this.#action.kind !== "linear-endpoint" ||
      snap === undefined ||
      !selectionSnapFeatureEnabled(snap, "connections")
    ) {
      this.#snapCandidate = null;
      return;
    }
    const target = this.#targetElement(this.#action.elementId);
    if (target.kind !== "line" && target.kind !== "arrow") {
      this.#snapCandidate = null;
      return;
    }
    this.#snapCandidate = findSnapCandidate(
      {
        current: this.#snapCandidate,
        pointer: this.#currentPointer,
        pointerType: snap.pointerType,
        zoom: snap.zoom,
      },
      snap.spatial,
      {
        get: (id) =>
          id === target.id || !(snap.canConnect?.(target.id, id) ?? true)
            ? null
            : (snap.targets.get(id) ?? null),
      },
      this.#snapScratch,
    );
  }

  #previewTransform(approximateScaleFrame = false): SelectionPreviewTransform | null {
    if (this.#action.kind === "move") return { delta: this.#translation(), kind: "translate" };
    if (this.#action.kind === "scale") {
      const scale = this.#requiredScale();
      const factors = scale.previewFactors(
        this.#currentPointer,
        this.#uniformScale,
        approximateScaleFrame,
      );
      if (this.#elements.length === 1) {
        const element = this.#elements[0]!;
        return {
          anchor: this.#action.anchor,
          delta: scale.previewDelta,
          factors,
          kind: "scale",
          rotation: element.rotation,
        };
      }
      return {
        anchor: this.#action.anchor,
        delta: scale.previewDelta,
        factors,
        kind: "scale",
        rotation: this.#action.rotation,
      };
    }
    if (this.#action.kind === "rotate") {
      return {
        center: this.#action.center,
        degrees: this.#rotationDeltaAt(this.#currentPointer),
        kind: "rotate",
      };
    }
    return null;
  }

  #previewFrame() {
    return this.#action.kind === "scale" ? this.#requiredScale().previewFrame : null;
  }

  #translation(): PointV1 {
    return this.#translationAt(this.#currentPointer);
  }

  #translationAt(pointer: PointV1): PointV1 {
    return {
      x: pointer.x - this.#startPointer.x,
      y: pointer.y - this.#startPointer.y,
    };
  }

  #rotationDeltaAt(pointer: PointV1): number {
    return selectionRotationDelta(
      this.#action,
      this.#elements,
      this.#startPointer,
      pointer,
      this.#currentSnap(),
    );
  }

  #snapGuide(): SelectionSnapGuide | null {
    return selectionHandleSnapGuide(
      this.#action,
      this.#elements,
      this.#startPointer,
      this.#currentPointer,
      this.#snapCandidate,
      this.#currentSnap(),
    );
  }

  #currentSnap(): SelectionSnapPorts | undefined {
    const snap = this.#snap;
    if (snap === undefined) return undefined;
    const { features: _features, ...base } = snap;
    return this.#snapFeatures === undefined ? base : { ...base, features: this.#snapFeatures };
  }

  #targetElement(id: string): InkElementV1 {
    const element = this.#elements.find((candidate) => candidate.id === id);
    if (element === undefined) throw new RangeError("The handle target is not selected.");
    return element;
  }

  #assertActionTarget(): void {
    if ("elementId" in this.#action) this.#targetElement(this.#action.elementId);
  }

  #hasChanged(): boolean {
    return (
      this.#currentPointer.x !== this.#startPointer.x ||
      this.#currentPointer.y !== this.#startPointer.y
    );
  }

  #requiresTimeSlicedCommit(): boolean {
    return exceedsReplacementWork(
      this.#elements,
      this.#planner,
      SYNCHRONOUS_SELECTION_LIMIT,
      SYNCHRONOUS_SELECTION_WORK_LIMIT,
      this.#replacementWorkOptions(),
    );
  }

  #replacementWorkOptions(): ReplacementWorkOptions {
    if (this.#snapCandidate?.anchor.kind === "linear-endpoint") {
      return { hasLinearConnectionTarget: true };
    }
    if (this.#action.kind === "move") return MOVE_REPLACEMENT_WORK;
    return this.#action.kind === "table-header" || this.#action.kind === "table-column"
      ? TABLE_SEPARATOR_REPLACEMENT_WORK
      : DEFAULT_REPLACEMENT_WORK;
  }

  #preparationCancelled(scheduler: TransformSliceScheduler, generation: number): boolean {
    return (
      this.#cancelled || this.#generation !== generation || (scheduler.isCancelled?.() ?? false)
    );
  }

  #emptyPreview(): SelectionHandlePreview {
    return {
      exactElements: [],
      exactPreviewTruncated: false,
      previewFrame: null,
      snapCandidate: null,
      snapGuide: null,
      transform: null,
    };
  }

  #assertActive(): void {
    if (this.#cancelled) throw new Error("A cancelled handle session cannot be used.");
  }
}
