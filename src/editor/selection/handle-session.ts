import { pointDistance, rotatePointClockwise } from "../../domain/geometry/public";
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
  SelectionPreviewTransform,
  SelectionSnapGuide,
  SelectionSnapPorts,
  TimeSlicedSelectionCommitPreparation,
} from "./handle-types";
import { selectionHandleSnapGuide, selectionRotationDelta } from "./handle-snap-resolution";
import { activeScaleAxes } from "./handle-session-geometry";
import {
  minimumUniformScaleForSelection,
  moveSelection,
  rotateSelection,
  scaleElementFromPointers,
  scaleFactorsFromPointers,
  scaleSelectionFromPointers,
  scaleSelectionUniformAtLeast,
  uniformScaleFactorFromPointers,
  type TransformSliceScheduler,
} from "./transforms";
import { materializeTargetedHandle } from "./targeted-handle-action";
import {
  exceedsExactPreviewWork,
  exceedsReplacementWork,
  type SelectionReplacementPlanner,
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
const TABLE_SEPARATOR_REPLACEMENT_WORK = Object.freeze({ includeReverseDependencies: false });

export class SelectionHandleSession {
  readonly #action: SelectionHandleAction;
  readonly #elements: readonly InkElementV1[];
  readonly #planner: SelectionReplacementPlanner;
  readonly #minimumUniformScale: number | undefined;
  readonly #snapScratch = new SnapCandidateScratch();
  readonly #snap: SelectionSnapPorts | undefined;
  readonly #startPointer: PointV1;
  #cancelled = false;
  #currentPointer: PointV1;
  #generation = 0;
  #preview: SelectionHandlePreview;
  #snapCandidate: SnapCandidate | null = null;
  #valid = true;

  public constructor(options: SelectionHandleSessionOptions) {
    if (options.elements.length === 0) throw new RangeError("A handle session needs a selection.");
    assertFinitePoint(options.startPointer);
    this.#action = options.action;
    this.#elements = options.elements;
    this.#planner = options.planner;
    this.#minimumUniformScale =
      options.action.kind === "scale" && options.elements.length > 1
        ? minimumUniformScaleForSelection(options.elements)
        : undefined;
    this.#snap = options.snap;
    this.#startPointer = options.startPointer;
    this.#currentPointer = options.startPointer;
    this.#assertActionTarget();
    this.#preview = this.#emptyPreview();
  }

  public get preview(): SelectionHandlePreview {
    return this.#preview;
  }

  public cancel(): void {
    this.#cancelled = true;
    this.#generation += 1;
    this.#snapCandidate = null;
    this.#preview = this.#emptyPreview();
  }

  public update(pointer: PointV1): SelectionHandlePreview {
    this.#assertActive();
    assertFinitePoint(pointer);
    this.#currentPointer = pointer;
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
    const plan = this.#planner.planReplacements(this.#materializeDirect());
    if (plan === null) return { status: "noop" };
    return { previous: this.#elements, replacements: plan.replacements, status: "ready" };
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
    const plan = await this.#planner.planReplacementsTimeSliced(materialized, {
      isCancelled: () => this.#preparationCancelled(scheduler, generation),
      shouldYield: scheduler.shouldYield,
      yieldControl: scheduler.yieldControl,
    });
    if (plan === "cancelled") return { status: "cancelled" };
    return plan === null
      ? { status: "noop" }
      : { previous: this.#elements, replacements: plan.replacements, status: "ready" };
  }

  #createPreview(): SelectionHandlePreview {
    if (!this.#hasChanged()) return this.#emptyPreview();
    const transform = this.#previewTransform();
    if (exceedsExactPreviewWork(this.#elements, this.#planner, this.#replacementWorkOptions())) {
      this.#valid = true;
      return {
        exactElements: [],
        exactPreviewTruncated: true,
        snapCandidate: this.#snapCandidate,
        snapGuide: this.#snapGuide(),
        transform,
      };
    }
    try {
      const planned = this.#planner.planReplacements(this.#materializeDirect());
      this.#valid = planned !== null;
      return {
        exactElements: planned?.elements ?? [],
        exactPreviewTruncated: false,
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
        return this.#elements.length === 1
          ? [this.#scaleSingle(this.#elements[0]!)]
          : scaleSelectionFromPointers(
              this.#elements,
              this.#action.anchor,
              this.#startPointer,
              this.#currentPointer,
              this.#minimumUniformScale,
            );
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
    const uniformFactor = await this.#timeSlicedUniformFactor(scheduler, generation, pointer);
    if (uniformFactor === null) return null;
    const replacements: InkElementV1[] = [];
    for (const element of this.#elements) {
      if (this.#preparationCancelled(scheduler, generation)) return null;
      replacements.push(this.#materializeOne(element, uniformFactor, pointer));
      if (!(await this.#continuePreparation(scheduler, generation))) return null;
    }
    return this.#preparationCancelled(scheduler, generation) ? null : replacements;
  }

  #materializeOne(
    element: InkElementV1,
    uniformFactor: number | undefined,
    pointer: PointV1,
  ): InkElementV1 {
    if (this.#action.kind === "move") {
      return moveSelection([element], this.#translationAt(pointer))[0]!;
    }
    if (this.#action.kind === "rotate") {
      return rotateSelection([element], this.#action.center, this.#rotationDeltaAt(pointer))[0]!;
    }
    if (this.#action.kind === "scale") {
      return uniformFactor === undefined
        ? this.#scaleSingleAt(element, pointer)
        : scaleSelectionUniformAtLeast(
            [element],
            this.#action.anchor,
            uniformFactor,
            this.#minimumUniformScale ?? 0,
          )[0]!;
    }
    return this.#replaceActionTargetAt(pointer)[0]!;
  }

  async #timeSlicedUniformFactor(
    scheduler: TransformSliceScheduler,
    generation: number,
    pointer: PointV1,
  ): Promise<number | null | undefined> {
    if (this.#action.kind !== "scale" || this.#elements.length === 1) return undefined;
    const factor = uniformScaleFactorFromPointers(
      this.#action.anchor,
      this.#startPointer,
      pointer,
      this.#minimumUniformScale,
    );
    if (this.#preparationCancelled(scheduler, generation)) return null;
    return Math.max(factor, this.#minimumUniformScale ?? 0);
  }

  #replaceActionTarget(): InkElementV1[] {
    return this.#replaceActionTargetAt(this.#currentPointer);
  }

  #replaceActionTargetAt(pointer: PointV1): InkElementV1[] {
    const action = this.#action;
    if (!("elementId" in action)) throw new Error("Expected a targeted handle action.");
    const element = this.#targetElement(action.elementId);
    const candidate =
      action.kind === "linear-endpoint"
        ? this.#validEndpointCandidate(
            rotatePointClockwise(
              action.endpoint === "start"
                ? assertLinearElement(element).end
                : assertLinearElement(element).start,
              element.pivot,
              element.rotation,
            ),
          )
        : null;
    return [materializeTargetedHandle({ action, candidate, element, pointer, snap: this.#snap })];
  }

  #scaleSingle(element: InkElementV1): InkElementV1 {
    return this.#scaleSingleAt(element, this.#currentPointer);
  }

  #scaleSingleAt(element: InkElementV1, pointer: PointV1): InkElementV1 {
    if (this.#action.kind !== "scale") throw new Error("Expected a scale action.");
    return scaleElementFromPointers(
      element,
      this.#action.anchor,
      this.#startPointer,
      pointer,
      activeScaleAxes(this.#action.position),
    );
  }

  #updateSnapCandidate(): void {
    if (this.#action.kind !== "linear-endpoint" || this.#snap === undefined) {
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
        pointerType: this.#snap.pointerType,
        zoom: this.#snap.zoom,
      },
      this.#snap.spatial,
      {
        get: (id) =>
          id === target.id || !(this.#snap?.canConnect?.(target.id, id) ?? true)
            ? null
            : (this.#snap?.targets.get(id) ?? null),
      },
      this.#snapScratch,
    );
  }

  #validEndpointCandidate(opposite: PointV1): SnapCandidate | null {
    const candidate = this.#snapCandidate;
    return candidate !== null && pointDistance(candidate.point, opposite) >= 8 ? candidate : null;
  }

  #previewTransform(): SelectionPreviewTransform | null {
    if (this.#action.kind === "move") return { delta: this.#translation(), kind: "translate" };
    if (this.#action.kind === "scale") {
      if (this.#elements.length === 1) {
        const element = this.#elements[0]!;
        const { factors } = scaleFactorsFromPointers(
          element,
          this.#action.anchor,
          this.#startPointer,
          this.#currentPointer,
          activeScaleAxes(this.#action.position),
        );
        return {
          anchor: this.#action.anchor,
          factors,
          kind: "scale",
          rotation: element.rotation,
        };
      }
      const factor = this.#uniformScaleFactor(this.#currentPointer);
      return {
        anchor: this.#action.anchor,
        factors: { x: factor, y: factor },
        kind: "scale",
        rotation: 0,
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

  #uniformScaleFactor(pointer: PointV1): number {
    if (this.#action.kind !== "scale") throw new Error("Expected a scale action.");
    return uniformScaleFactorFromPointers(
      this.#action.anchor,
      this.#startPointer,
      pointer,
      this.#minimumUniformScale,
    );
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
      this.#snap,
    );
  }

  #snapGuide(): SelectionSnapGuide | null {
    return selectionHandleSnapGuide(
      this.#action,
      this.#elements,
      this.#startPointer,
      this.#currentPointer,
      this.#snapCandidate,
      this.#snap,
    );
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

  #replacementWorkOptions(): { readonly includeReverseDependencies: boolean } {
    return this.#action.kind === "table-header" || this.#action.kind === "table-column"
      ? TABLE_SEPARATOR_REPLACEMENT_WORK
      : DEFAULT_REPLACEMENT_WORK;
  }

  async #continuePreparation(
    scheduler: TransformSliceScheduler,
    generation: number,
  ): Promise<boolean> {
    if (this.#preparationCancelled(scheduler, generation)) return false;
    if (scheduler.shouldYield()) await scheduler.yieldControl();
    return !this.#preparationCancelled(scheduler, generation);
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
      snapCandidate: null,
      snapGuide: null,
      transform: null,
    };
  }

  #assertActive(): void {
    if (this.#cancelled) throw new Error("A cancelled handle session cannot be used.");
  }
}

function assertFinitePoint(point: PointV1): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError("Handle points must be finite.");
  }
}

function assertLinearElement(
  element: InkElementV1,
): Extract<InkElementV1, { kind: "arrow" | "line" | "straight-highlighter" }> {
  if (
    element.kind !== "line" &&
    element.kind !== "arrow" &&
    element.kind !== "straight-highlighter"
  ) {
    throw new TypeError("Endpoint handles require a linear drawing element.");
  }
  return element;
}
