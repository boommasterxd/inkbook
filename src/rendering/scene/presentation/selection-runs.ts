import type { StoreOrderCursor } from "../../../domain/store/mutations/order-cursor";
import type { InkElementV1 } from "../../../domain/schema/public";
import type { MountedSceneElement } from "../content/mounted-element";
import type { ScenePublicationBudget } from "../reconciliation/mount-slice";
import type { PreviewTransform } from "../reconciliation/scene-visibility-reconciler";
import type { SceneDeltaEntry, SceneElementRecord } from "../types";
import type { ProgressivePreviewTransform } from "./progressive-preview-request";
import {
  canonicalRunMember,
  selectionRunPlanMemoryUsage,
  SelectionRunPlanning,
  type SelectionRunPlan,
} from "./selection-run-plan";
import { SelectionRunGroups } from "./selection-run-groups";
import { SelectionRunTraces } from "./selection-run-traces";
import { SceneRunStrokeWidth } from "./selection-run-width";
import type { SelectionFeedbackTransforms } from "./selection-feedback-transforms";
import { SelectionRunTargets } from "./selection-run-targets";
import { SelectionRunRebase } from "./selection-run-rebase";

import { SelectionRunFeedback, type SelectionRunPorts } from "./selection-run-feedback";

/** Plans prepared physical cohorts through the existing scene admission. */
export class SceneSelectionRuns {
  readonly #feedback: SelectionRunFeedback;
  readonly groups: SelectionRunGroups;
  readonly #traces: SelectionRunTraces;
  readonly #width: SceneRunStrokeWidth;
  readonly #targets = new SelectionRunTargets();
  #selection: ReadonlySet<string> | undefined;
  #requested: ReadonlySet<string> | undefined;
  #planning: SelectionRunPlanning | undefined;
  #plan: SelectionRunPlan | undefined;
  #version: StoreOrderCursor | undefined;
  #exceptions = new Set<string>();
  #cleaning = false;
  #ready = false;
  #fallback = false;
  #retire = false;
  #released = false;
  readonly #rebase = new SelectionRunRebase();
  public get transforms(): SelectionFeedbackTransforms {
    return this.#feedback.transforms;
  }
  public constructor(private readonly ports: SelectionRunPorts) {
    this.groups = new SelectionRunGroups({
      dom: ports.dom,
      instrumentation: ports.instrumentation,
      paint: (container, active) => this.#width.setActive(container, active),
    });
    this.#traces = new SelectionRunTraces({
      container: ports.dom.selectionTraceGroup,
      node: ports.trace,
      instrumentation: ports.instrumentation,
    });
    this.#width = new SceneRunStrokeWidth({
      svg: ports.dom.svg,
      instrumentation: ports.instrumentation,
      zoom: ports.zoom,
    });
    this.#feedback = new SelectionRunFeedback({
      ports,
      groups: this.groups,
      traces: this.#traces,
      width: this.#width,
      targets: this.#targets,
      selection: () => this.#selection,
      plan: () => this.#plan,
      exceptions: () => this.#exceptions,
      ready: () => this.#ready,
      sourceValid: () => this.sourceValid(),
      grouped: (id) => this.grouped(id),
      canRetain: () => !this.#retire && this.groups.ready,
      retaining: () => {
        this.#ready = false;
        this.#cleaning = false;
        this.readyAttribute();
      },
      finished: (hasSkipped) => {
        this.#ready =
          !this.#retire && !hasSkipped && this.#requested === this.#selection && this.groups.ready;
        if (!this.#ready) this.#cleaning = true;
        this.#version = this.ports.store.beginOrder?.();
        this.#planning = undefined;
        this.readyAttribute();
      },
      cleared: () => {
        if (this.#requested !== this.#selection) this.restart();
      },
    });
  }
  public get active(): boolean {
    return this.#feedback.active;
  }
  public get committing(): boolean {
    return this.#feedback.committing;
  }
  public get cleaning(): boolean {
    return this.#cleaning;
  }
  public get structuralRetirement(): boolean {
    return this.#retire;
  }
  public get hasRetainableFeedback(): boolean {
    return this.#feedback.hasRetainableFeedback;
  }
  public stage(feedback: ProgressivePreviewTransform | undefined): void {
    return this.#feedback.stage(feedback);
  }
  public get pending(): boolean {
    return (
      this.#cleaning ||
      this.#planning?.done === false ||
      (this.#plan !== undefined && !this.#ready) ||
      this.#feedback.committing
    );
  }
  public has(id: string): boolean {
    return this.#plan?.members.has(id) === true;
  }
  public grouped(id: string): boolean {
    return this.has(id) && !this.#exceptions.has(id);
  }
  public invalidate(kind: "geometry" | "structure" = "structure"): void {
    if ((this.active || this.#feedback.committing) && kind === "structure") this.#retire = true;
    if (
      this.active ||
      this.#feedback.committing ||
      this.#cleaning ||
      (this.#plan === undefined && this.#planning === undefined && !this.#fallback)
    )
      return;
    this.#ready = false;
    this.#rebase.clear();
    this.#fallback = false;
    this.#cleaning = true;
    this.readyAttribute();
  }
  public geometryChanged(id: string, change: SceneDeltaEntry | undefined): void {
    if (
      this.#plan !== undefined &&
      (this.#ready || this.#rebase.active) &&
      !this.active &&
      !this.#feedback.committing &&
      !this.#cleaning &&
      this.#rebase.track(change, this.#plan.members.get(id), this.ports.mounted.get(id))
    ) {
      this.#ready = false;
      this.readyAttribute();
      return;
    }
    this.invalidate("geometry");
  }
  public finishDelta(geometryOnly: boolean): void {
    if (!this.#rebase.active) return;
    if (!geometryOnly) {
      this.invalidate();
      return;
    }
    this.#version = this.ports.store.beginOrder?.();
    this.#planning = undefined;
    if (!this.#rebase.pending) this.finishRebase();
  }
  private finishRebase(): void {
    this.#rebase.clear();
    this.#ready = !this.#cleaning && this.groups.ready;
    this.readyAttribute();
  }
  public mounted(entry: MountedSceneElement): void {
    if (this.#plan?.members.has(entry.id) === true && !this.active && !this.#feedback.committing) {
      this.#ready = false;
      this.#cleaning = true;
      this.readyAttribute();
    }
  }
  public unmounted(id: string): void {
    this.#feedback.unmounted(id);
    const entry = this.#plan?.members.get(id);
    if (entry === undefined) return;
    this.#width.release(entry);
    if (!this.active && !this.#feedback.committing) {
      this.#ready = false;
      this.#cleaning = true;
      this.readyAttribute();
    }
  }
  public setSelection(selection: ReadonlySet<string>): void {
    if (selection === this.#requested) return;
    this.#requested = selection;
    this.#ready = false;
    this.#fallback = false;
    this.readyAttribute();
    if (!this.#feedback.active) this.restart();
  }
  private restart(): void {
    this.#rebase.clear();
    this.#cleaning = this.#plan !== undefined;
    if (this.#cleaning) return;
    this.#selection = this.#requested;
    this.#planning =
      this.#selection === undefined
        ? undefined
        : new SelectionRunPlanning(
            this.#selection,
            this.ports.store,
            this.ports.mounted,
            (entry) =>
              (entry.group === null ? entry.paths.length : 1) +
              Number(this.ports.trace(entry.id) !== undefined),
          );
    this.#plan = undefined;
    this.#version = undefined;
  }
  public prepare(
    deadline: number,
    now: () => number,
    publication: ScenePublicationBudget,
  ): boolean {
    if (this.#feedback.committing || this.#feedback.active) return this.pending;
    if (this.#cleaning) {
      if (
        !this.groups.cleanup(deadline, now, (entry) => {
          this.#width.release(entry);
          this.#traces.releaseMember(entry);
        })
      )
        return true;
      this.#traces.cleanup();
      this.#plan = undefined;
      this.#planning?.cancel();
      this.#planning = undefined;
      this.#cleaning = false;
      this.#exceptions.clear();
      this.#targets.discard();
      this.#feedback.cohortReleased();
      this.#retire = false;
      this.#rebase.clear();
      this.restart();
    }
    while (this.#planning !== undefined && !this.#planning.done && now() < deadline)
      this.#planning.step();
    if (this.#plan === undefined && this.#planning?.done) {
      const plan = this.#planning.result;
      if (plan === undefined) {
        this.#planning = undefined;
        this.#fallback = true;
        this.readyAttribute();
        return false;
      }
      this.#plan = plan;
      this.#exceptions = new Set(plan.exceptions.map((entry) => entry.id));
      this.groups.begin(plan.groups);
    }
    const plan = this.#plan;
    if (plan === undefined) return this.pending;
    if (!this.sourceValid()) {
      this.invalidate();
      return true;
    }
    if (!this.#traces.prepare(deadline, now, publication)) return true;
    if (
      !this.groups.prepare(deadline, now, publication, (entry) => {
        const record = this.ports.store.get(entry.id);
        if (
          this.ports.mounted.get(entry.id) !== entry ||
          record?.geometryVersion !== entry.geometryVersion ||
          !canonicalRunMember(entry)
        ) {
          this.#ready = false;
          this.#cleaning = true;
          this.readyAttribute();
          return false;
        }
        this.#width.prepare(entry);
        this.#targets.prepare(entry, record);
        this.#traces.member(entry);
        return true;
      })
    )
      return true;
    this.#ready = this.groups.ready;
    this.readyAttribute();
    return !this.#ready;
  }
  private readyAttribute(): void {
    if (this.#ready) this.ports.dom.svg.setAttribute("data-inkbook-run-ready", "true");
    else this.ports.dom.svg.removeAttribute("data-inkbook-run-ready");
    if (this.#fallback) this.ports.dom.svg.setAttribute("data-inkbook-run-fallback", "true");
    else this.ports.dom.svg.removeAttribute("data-inkbook-run-fallback");
  }
  public canUse(feedback: ProgressivePreviewTransform | undefined): boolean {
    return this.#feedback.canUse(feedback);
  }
  private sourceValid(): boolean {
    return this.#version === undefined
      ? this.#planning?.valid() === true
      : !this.#version.advance().stale;
  }
  public ids(feedback: ProgressivePreviewTransform | undefined): readonly string[] | undefined {
    return this.#feedback.ids(feedback);
  }
  public snapshotIds(
    feedback: ProgressivePreviewTransform | undefined,
  ): readonly string[] | undefined {
    return this.#feedback.snapshotIds(feedback);
  }
  public exceptionIds(
    feedback: ProgressivePreviewTransform | undefined,
  ): readonly string[] | undefined {
    return this.canUse(feedback) ? this.#plan?.exceptionIds : undefined;
  }
  public publish(feedback: ProgressivePreviewTransform, version: number): boolean {
    return this.#feedback.publish(feedback, version);
  }
  public refreshZoom(): void {
    return this.#feedback.refreshZoom();
  }
  public capture(id: string, change: SceneDeltaEntry): void {
    return this.#feedback.capture(id, change);
  }
  public canonicalTarget(id: string): SceneElementRecord | undefined {
    return this.#feedback.canonicalTarget(id);
  }
  public basis(id: string, feedback: ProgressivePreviewTransform | undefined): void {
    return this.#feedback.basis(id, feedback);
  }
  public applyTransform(
    entry: MountedSceneElement,
    version: number,
    transform?: string | null,
    width: number | null = null,
    matrix?: ProgressivePreviewTransform["matrix"],
  ): boolean {
    return this.#feedback.applyTransform(entry, version, transform, width, matrix);
  }
  public update(entry: MountedSceneElement, record?: SceneElementRecord): void {
    this.#feedback.canonicalPublished(entry, record);
    const proof = this.#rebase.published(entry);
    if (proof !== "untracked") {
      if (proof === "invalid" || (!this.#exceptions.has(entry.id) && !this.groups.owns(entry))) {
        this.invalidate();
      } else if (record !== undefined && !this.#exceptions.has(entry.id))
        this.#targets.prepare(entry, record);
      if (this.#rebase.active && !this.#rebase.pending) this.finishRebase();
    }
    if (this.groups.owns(entry)) this.#width.prepare(entry);
  }
  public bindTrace(entry: MountedSceneElement): void {
    return this.#feedback.bindTrace(entry);
  }
  public needsVisibleGeometry(entry: MountedSceneElement): boolean {
    return this.#feedback.needsVisibleGeometry(entry);
  }
  public canWriteVisibleGeometry(entry: MountedSceneElement): boolean {
    return this.#feedback.canWriteVisibleGeometry(entry);
  }
  public pendingPreview(id: string): PreviewTransform | undefined {
    return this.#feedback.pendingPreview(id);
  }
  public worldTransform(id: string): PreviewTransform | undefined {
    return this.#feedback.worldTransform(id);
  }
  public retainCommit(): boolean {
    return this.#feedback.retainCommit();
  }
  public exceptionTransforms(): ReadonlyMap<string, PreviewTransform> {
    return this.#feedback.exceptionTransforms();
  }
  public exceptionElements(
    elements: ReadonlyMap<string, InkElementV1>,
  ): ReadonlyMap<string, InkElementV1> {
    return this.#feedback.exceptionElements(elements);
  }
  public normalize(
    deadline: number,
    now: () => number,
    write: (id: string, skipGeometry?: boolean) => boolean,
    admittedFirstStep = false,
  ): boolean {
    return this.#feedback.normalize(deadline, now, write, admittedFirstStep);
  }
  public clear(): void {
    return this.#feedback.clear();
  }
  public memoryUsage(): number {
    if (this.#released) return 0;
    return (
      (this.#planning?.memoryUsage(this.#plan !== undefined) ??
        selectionRunPlanMemoryUsage(this.#plan, true)) +
      this.#exceptions.size * 40 +
      this.groups.memoryUsage() +
      this.#traces.memoryUsage() +
      this.widthMemoryEstimate() +
      this.#targets.memoryUsage() +
      this.#feedback.memoryUsage() +
      this.#rebase.memoryUsage()
    );
  }
  private widthMemoryEstimate(): number {
    const owned = this.#width.memoryUsage();
    // Owned-storage estimate only; actual DOM/browser allocator costs are measured separately.
    return owned.trackedEntries * 64 + owned.trackedPaths * 192 + owned.paletteOverrides * 128;
  }
  public release(): void {
    this.#released = true;

    this.#planning?.cancel();
    this.groups.discard();
    this.#width.discard();
    this.#targets.discard();
    this.#feedback.release();

    this.#rebase.clear();
    this.#traces.release();
    this.#plan = undefined;
    this.#planning = undefined;

    this.#exceptions.clear();

    this.#cleaning = false;
    this.#ready = false;
  }
}
