import { updatePreviewTransform, type MountedSceneElement } from "../content/mounted-element";
import type { SceneElementRecord } from "../types";
import type { SelectionRunPlan } from "./selection-run-plan";
import type { SelectionRunGroups } from "./selection-run-groups";
import type { SelectionRunTraces } from "./selection-run-traces";
import type { SelectionRunTargets } from "./selection-run-targets";
import type { SceneRunStrokeWidth } from "./selection-run-width";
import { SelectionFeedbackTransforms } from "./selection-feedback-transforms";
import type { ProgressivePreviewTransform } from "./progressive-preview-request";
import type { PreviewTransform } from "../reconciliation/scene-visibility-reconciler";
import type { InkElementV1 } from "../../../domain/schema/public";
import type { SceneDeltaEntry, MutableSceneInstrumentation, SceneStorePort } from "../types";
import type { SceneDom } from "../scene-dom";
import {
  SelectionRunResiduals,
  composeMatrices,
  inverseMatrix,
  IDENTITY_MATRIX,
} from "./selection-run-residuals";
import { SelectionRunHidden } from "./selection-run-hidden";
export interface SelectionRunPorts {
  readonly dom: SceneDom;
  readonly mounted: ReadonlyMap<string, MountedSceneElement>;
  readonly store: SceneStorePort;
  readonly instrumentation: MutableSceneInstrumentation;
  readonly trace: (id: string) => SVGElement | undefined;
  readonly zoom: () => number;
  readonly visible: (id: string) => boolean;
  readonly syncTrace: (entry: MountedSceneElement) => void;
}
interface FeedbackContext {
  readonly ports: SelectionRunPorts;
  readonly groups: SelectionRunGroups;
  readonly traces: SelectionRunTraces;
  readonly width: SceneRunStrokeWidth;
  readonly targets: SelectionRunTargets;
  readonly selection: () => ReadonlySet<string> | undefined;
  readonly plan: () => SelectionRunPlan | undefined;
  readonly exceptions: () => ReadonlySet<string>;
  readonly ready: () => boolean;
  readonly sourceValid: () => boolean;
  readonly grouped: (id: string) => boolean;
  readonly canRetain: () => boolean;
  readonly retaining: () => void;
  readonly finished: (hasSkipped: boolean) => void;
  readonly cleared: () => void;
}

/** Owns physical feedback bases and their canonical publication handoff. */
export class SelectionRunFeedback {
  readonly #residuals = new SelectionRunResiduals();
  readonly #skipped = new Set<string>();
  readonly #basis = new Map<string, ProgressivePreviewTransform>();
  #canonical = new Set<string>();
  #current: ProgressivePreviewTransform | undefined;
  #frameVersion = 0;
  #committing = false;
  #frozen: string | null = null;
  #frozenMatrix: ProgressivePreviewTransform["matrix"];
  #committed: string | null = null;
  #committedMatrix: ProgressivePreviewTransform["matrix"] | undefined;
  #directFeedback = false;
  readonly #hidden: SelectionRunHidden;
  public readonly transforms: SelectionFeedbackTransforms;
  public constructor(private readonly context: FeedbackContext) {
    this.#hidden = new SelectionRunHidden(context.ports.instrumentation);
    this.transforms = new SelectionFeedbackTransforms({
      size: () =>
        this.#current === undefined && !this.#committing ? 0 : (context.plan()?.members.size ?? 0),
      ids: () => context.plan()?.ids ?? [],
      get: (id) => this.worldTransform(id),
    });
  }
  public unmounted(id: string): void {
    this.#skipped.delete(id);
    this.#hidden.show(id);
  }
  public cohortReleased(): void {
    this.#residuals.discard();
    this.#basis.clear();
    this.#canonical.clear();
  }
  public memoryUsage(): number {
    return (
      this.#residuals.memoryUsage() +
      this.#hidden.memoryUsage() +
      this.#skipped.size * 40 +
      this.#basis.size * 40 +
      this.#canonical.size * 40 +
      2 *
        ((this.#frozen?.length ?? 0) +
          (this.#committed?.length ?? 0) +
          (this.#current?.transform.length ?? 0))
    );
  }
  public release(): void {
    this.cohortReleased();
    this.#hidden.discard();
    this.#skipped.clear();
    this.#current = undefined;
    this.#committing = false;
    this.#directFeedback = false;
    this.#frozen = null;
    this.#frozenMatrix = undefined;
    this.#committed = null;
    this.#committedMatrix = undefined;
  }
  public get active(): boolean {
    return this.#current !== undefined;
  }
  public get committing(): boolean {
    return this.#committing;
  }
  public get hasRetainableFeedback(): boolean {
    return this.active && (this.context.ready() || this.#committing || this.context.canRetain());
  }
  public stage(feedback: ProgressivePreviewTransform | undefined): void {
    if (
      feedback === undefined ||
      feedback.selection !== this.context.selection() ||
      (!this.context.ready() && !this.#committing && !this.active)
    )
      return;
    if (feedback.matrix !== undefined) {
      const prefix = composeMatrices(feedback.matrix, this.#committedMatrix ?? IDENTITY_MATRIX);
      if (
        (this.context.ready() || this.#committing) &&
        inverseMatrix(prefix) !== undefined &&
        (!this.#committing ||
          inverseMatrix(composeMatrices(prefix, this.#frozenMatrix)) !== undefined)
      )
        return;
    }
    this.#directFeedback = true;
    this.#current ??= {
      ...feedback,
      matrix: IDENTITY_MATRIX,
      invertible: true,
      transform: "matrix(1 0 0 1 0 0)",
      inverse: "matrix(1 0 0 1 0 0)",
    };
  }
  public canUse(feedback: ProgressivePreviewTransform | undefined): boolean {
    if (this.#directFeedback) return false;
    if (!this.context.ready() && !this.#committing) return false;
    if (feedback?.matrix === undefined || !feedback.matrix.every(Number.isFinite)) return false;
    const prefix = composeMatrices(feedback.matrix, this.#committedMatrix ?? IDENTITY_MATRIX);
    if (
      inverseMatrix(prefix) === undefined ||
      (this.#committing && inverseMatrix(composeMatrices(prefix, this.#frozenMatrix)) === undefined)
    )
      return false;
    return (
      (this.#committing || this.context.sourceValid()) &&
      feedback.selection === this.context.selection() &&
      feedback.selectionSize === this.context.selection()?.size
    );
  }
  public ids(feedback: ProgressivePreviewTransform | undefined): readonly string[] | undefined {
    if (this.#directFeedback && feedback?.selection === this.context.selection())
      return this.context.plan()?.ids;
    return this.canUse(feedback) ? this.context.plan()?.ids : undefined;
  }
  public snapshotIds(
    feedback: ProgressivePreviewTransform | undefined,
  ): readonly string[] | undefined {
    if (this.#directFeedback && feedback?.selection === this.context.selection())
      return this.#committing
        ? this.context.plan()?.exceptions.map((entry) => entry.id)
        : this.context.plan()?.snapshots;
    return this.canUse(feedback)
      ? this.#committing || feedback?.invertible !== true
        ? this.context.plan()?.exceptions.map((entry) => entry.id)
        : this.context.plan()?.snapshots
      : undefined;
  }
  public publish(feedback: ProgressivePreviewTransform, version: number): boolean {
    if (!this.canUse(feedback)) return false;
    this.#current = feedback;
    this.#frameVersion = version;
    this.context.width.refreshZoom();
    this.publishParents();
    this.context.ports.dom.svg.setAttribute("data-inkbook-run-feedback", "true");
    return true;
  }
  public refreshZoom(): void {
    this.context.width.refreshZoom();
  }
  private publishParents(): void {
    if (!this.#committing) {
      this.context.groups.publish(this.#current?.transform ?? null);
      this.context.traces.publish(this.#current?.transform ?? null);
      return;
    }
    const prefix = joinTransforms(this.#current?.transform, this.#committed);
    const suffix = joinTransforms(prefix, this.#frozen);
    this.context.groups.publishBases(prefix, suffix);
    this.context.traces.publishBases(prefix, suffix);
  }
  public capture(id: string, change: SceneDeltaEntry): void {
    if (this.context.grouped(id) && (this.active || this.#committing)) {
      this.context.targets.capture(id, change, this.context.ports.store);
      const entry = this.context.ports.mounted.get(id);
      if (entry !== undefined) {
        if (this.#directFeedback) this.#residuals.retainBase(entry);
        this.#residuals.capture(entry, change.afterGeometryVersion);
      }
    }
  }
  public canonicalTarget(id: string): SceneElementRecord | undefined {
    return this.#committing && this.context.grouped(id)
      ? this.context.targets.record(id)
      : undefined;
  }
  public basis(id: string, feedback: ProgressivePreviewTransform | undefined): void {
    if (this.#committing || !this.context.grouped(id)) return;
    if (feedback === undefined) this.#basis.delete(id);
    else this.#basis.set(id, feedback);
  }
  public applyTransform(
    entry: MountedSceneElement,
    version: number,
    transform?: string | null,
    width: number | null = null,
    matrix?: ProgressivePreviewTransform["matrix"],
  ): boolean {
    this.#hidden.preview(entry.id, transform ?? null, version, width, matrix);
    if (!this.context.groups.owns(entry)) return false;
    if (this.#committing) {
      if (this.#directFeedback && transform !== null && transform !== undefined) {
        const previous = inverseMatrix(this.#current?.matrix ?? IDENTITY_MATRIX)!;
        transform = `${transform} matrix(${previous.join(" ")})`;
        matrix = matrix === undefined ? undefined : composeMatrices(matrix, previous);
      }
      this.#residuals.set(entry, transform ?? null, version, width, matrix);
      return this.#residuals.write(
        entry,
        this.parentMatrix(entry),
        this.context.ports.instrumentation,
      );
    }
    if (!this.active) return false;
    if (this.#directFeedback)
      return this.applyDirectTransform(entry, transform, version, width, matrix);
    updatePreviewTransform(
      entry,
      this.#basis.get(entry.id)?.inverse ?? null,
      version,
      this.context.ports.zoom(),
      this.context.ports.instrumentation,
      inverseMatrix(this.#basis.get(entry.id)?.matrix ?? IDENTITY_MATRIX),
    );
    return true;
  }
  private applyDirectTransform(
    entry: MountedSceneElement,
    transform: string | null | undefined,
    version: number,
    width: number | null,
    matrix: ProgressivePreviewTransform["matrix"],
  ): boolean {
    const parentInverse = inverseMatrix(this.parentMatrix(entry))!;
    const canonicalSnapshot = transform == null && this.#basis.has(entry.id);
    const localMatrix = canonicalSnapshot
      ? parentInverse
      : matrix === undefined
        ? undefined
        : composeMatrices(parentInverse, matrix);
    updatePreviewTransform(
      entry,
      transform == null && !canonicalSnapshot
        ? null
        : localMatrix === undefined
          ? `matrix(${parentInverse.join(" ")}) ${transform}`
          : `matrix(${localMatrix.join(" ")})`,
      version,
      width,
      this.context.ports.instrumentation,
      localMatrix,
    );
    return true;
  }
  private parentMatrix(
    entry: MountedSceneElement,
  ): NonNullable<ProgressivePreviewTransform["matrix"]> {
    if (!this.#committing) return this.#current?.matrix ?? IDENTITY_MATRIX;
    const prefix = composeMatrices(
      this.#current?.matrix ?? IDENTITY_MATRIX,
      this.#committedMatrix ?? IDENTITY_MATRIX,
    );
    return this.context.groups.inPrefix(entry)
      ? prefix
      : composeMatrices(prefix, this.#frozenMatrix);
  }
  public canonicalPublished(entry: MountedSceneElement, record?: SceneElementRecord): void {
    if (
      record !== undefined &&
      (!this.#committing ||
        !this.context.groups.owns(entry) ||
        this.context.groups.inPrefix(entry)) &&
      this.#skipped.delete(entry.id)
    ) {
      this.#residuals.canonical(entry, entry.geometryVersion);
      const kept =
        this.#committing &&
        this.context.groups.owns(entry) &&
        this.#residuals.write(entry, this.parentMatrix(entry), this.context.ports.instrumentation);
      if (!kept) {
        const desired = this.#hidden.livePreview(entry.id);
        if (
          desired !== undefined &&
          this.context.groups.owns(entry) &&
          this.active &&
          this.#directFeedback
        )
          this.applyTransform(
            entry,
            desired.version,
            desired.transform,
            desired.strokeWidthScale,
            desired.matrix,
          );
        else
          updatePreviewTransform(
            entry,
            desired?.transform ?? null,
            desired?.version ?? Number.MAX_SAFE_INTEGER,
            desired?.strokeWidthScale ?? null,
            this.context.ports.instrumentation,
            desired?.matrix,
          );
      }
      this.#hidden.show(entry.id);
    }
  }
  public bindTrace(entry: MountedSceneElement): void {
    if (this.context.groups.owns(entry))
      this.context.traces.member(entry, this.#committing && this.#canonical.has(entry.id));
  }
  public needsVisibleGeometry(entry: MountedSceneElement): boolean {
    return this.#skipped.has(entry.id) && this.context.ports.visible(entry.id);
  }
  public canWriteVisibleGeometry(entry: MountedSceneElement): boolean {
    return (
      !this.#committing || !this.context.groups.owns(entry) || this.context.groups.inPrefix(entry)
    );
  }
  public pendingPreview(id: string): PreviewTransform | undefined {
    return this.#hidden.livePreview(id);
  }
  public worldTransform(id: string): PreviewTransform | undefined {
    if (this.context.plan()?.members.has(id) !== true) return undefined;
    const entry = this.context.ports.mounted.get(id);
    if (entry === undefined || (this.#current === undefined && !this.#committing)) return undefined;
    if (!this.context.exceptions().has(id) && !this.context.groups.owns(entry)) return undefined;
    return {
      transform: this.context.exceptions().has(id)
        ? entry.appliedPreviewTransform
        : (joinTransforms(
            this.context.groups.parentTransform(entry),
            entry.appliedPreviewTransform,
          ) ?? (this.#committing ? "matrix(1 0 0 1 0 0)" : null)),
      matrix: this.context.exceptions().has(id)
        ? entry.appliedPreviewMatrix
        : entry.appliedPreviewMatrix === undefined
          ? undefined
          : composeMatrices(this.parentMatrix(entry), entry.appliedPreviewMatrix),
      version: this.#frameVersion,
      strokeWidthScale: this.context.ports.zoom(),
    };
  }
  public retainCommit(): boolean {
    if (this.#committing && this.#current === undefined) return true;
    if (!this.active || (!this.context.ready() && !this.#committing && !this.context.canRetain()))
      return false;
    this.#directFeedback = false;
    if (this.#committing) {
      this.#committedMatrix = composeMatrices(this.#current!.matrix!, this.#committedMatrix);
      this.#committed = `matrix(${this.#committedMatrix.join(" ")})`;
      this.#current = undefined;
      this.publishParents();
      return true;
    }
    this.#frozen = this.#current!.transform;
    this.#frozenMatrix = this.#current!.matrix;
    this.#committed = null;
    this.#committedMatrix = undefined;
    this.#current = undefined;
    this.#committing = true;
    this.context.retaining();
    this.context.groups.beginCommit();
    this.context.targets.begin();

    return true;
  }
  public exceptionTransforms(): ReadonlyMap<string, PreviewTransform> {
    const result = new Map<string, PreviewTransform>();
    for (const id of this.context.exceptions()) {
      const preview = this.worldTransform(id);
      if (preview !== undefined) result.set(id, preview);
    }
    return result;
  }
  public exceptionElements(
    elements: ReadonlyMap<string, InkElementV1>,
  ): ReadonlyMap<string, InkElementV1> {
    const result = new Map<string, InkElementV1>();
    for (const id of this.context.exceptions()) {
      const element = elements.get(id);
      if (element !== undefined) result.set(id, element);
    }
    return result;
  }
  public normalize(
    deadline: number,
    now: () => number,
    write: (id: string, skipGeometry?: boolean) => boolean,
    admittedFirstStep = false,
  ): boolean {
    if (!this.#committing) return false;
    let stepped = false;
    while ((admittedFirstStep && !stepped) || now() < deadline) {
      const entry = this.context.groups.pendingCanonical;
      if (entry === undefined) {
        this.context.groups.finishCommit();
        this.context.traces.finishCommit();
        const next = this.context.targets.finish();
        this.#canonical = new Set();
        this.#basis.clear();
        if (next) {
          this.#frozen = this.#committed;
          this.#frozenMatrix = this.#committedMatrix;
          this.#committed = null;
          this.#committedMatrix = undefined;
          this.context.groups.beginCommit();
          this.publishParents();
          continue;
        }
        this.#committing = false;
        this.#frozen = null;
        this.#committed = null;
        this.#committedMatrix = undefined;
        this.context.finished(this.#skipped.size > 0);
        // Its last active legacy feedback is already painted locally; the
        // ordinary preview writer resumes ownership of canonical geometry.
        this.#residuals.discard();

        if (this.#current === undefined)
          this.context.ports.dom.svg.removeAttribute("data-inkbook-run-feedback");

        return false;
      }
      stepped = true;
      if (this.context.ports.mounted.get(entry.id) !== entry)
        throw new Error(
          "Run prototype requires mounted entry identity during canonical normalization.",
        );
      const skipGeometry = !this.context.ports.visible(entry.id);
      if (!write(entry.id, skipGeometry)) return true;
      const previousParent = this.parentMatrix(entry);
      this.context.groups.canonical(entry);
      if (skipGeometry) {
        this.#skipped.add(entry.id);
        this.#hidden.hide(entry, this.context.ports.trace(entry.id));
        this.#residuals.reparent(
          entry,
          previousParent,
          this.parentMatrix(entry),
          this.context.ports.zoom(),
        );
      } else {
        this.#skipped.delete(entry.id);
        this.#hidden.show(entry.id);
        this.#residuals.canonical(entry, entry.geometryVersion);
      }
      this.#residuals.write(entry, this.parentMatrix(entry), this.context.ports.instrumentation);
      this.context.traces.member(entry, true);
      this.context.ports.syncTrace(entry);
      this.#canonical.add(entry.id);
    }
    return true;
  }
  public clear(): void {
    this.#directFeedback = false;
    if (this.#committing) {
      this.#current = undefined;
      this.publishParents();
      return;
    }
    this.context.groups.publish(null);
    this.context.traces.publish(null);
    this.#current = undefined;
    this.#basis.clear();
    this.context.ports.dom.svg.removeAttribute("data-inkbook-run-feedback");
    this.context.cleared();
  }
}
function joinTransforms(...transforms: readonly (string | null | undefined)[]): string | null {
  return transforms.filter(Boolean).join(" ") || null;
}
