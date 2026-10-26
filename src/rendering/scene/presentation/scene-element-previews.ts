import type { PreviewTransform } from "../reconciliation/scene-visibility-reconciler";
import type { InkElementV1 } from "../../../domain/schema/public";
import type { SceneContentRenderer } from "../content-renderer";
import { SceneElementPreviewController } from "./element-preview-controller";
import { ProgressiveElementPreview } from "./progressive-element-preview";
import { ViewportPreviewSelection } from "./preview-transform-selection";
import type { SceneCamera, SceneStorePort, SceneViewport } from "../types";
import type { Bounds } from "../../../domain/geometry/public";
import { PreviewElementMap } from "./preview-element-map";
import { ConnectedPreviewCohort, type ProgressivePreviewPurpose } from "./connected-preview-cohort";

const NO_IDS: readonly string[] = [];
interface PreviewSelection {
  readonly camera: SceneCamera;
  readonly ids: readonly string[];
  readonly selected: readonly string[];
  readonly viewport: SceneViewport | undefined;
}

/** Owns synchronous and progressive previews under the same commit/cancel lifetime. */
export class SceneElementPreviews {
  public readonly immediate: SceneElementPreviewController;
  public readonly progressive: ProgressiveElementPreview;
  readonly #connected: ProgressiveElementPreview;
  readonly #store: SceneStorePort;
  readonly #values: PreviewElementMap;
  readonly #progressiveValues: PreviewElementMap;
  readonly #candidates = new ViewportPreviewSelection();
  readonly #connectedCohort = new ConnectedPreviewCohort();
  #purpose: ProgressivePreviewPurpose | undefined;
  #connectedSelection: PreviewSelection | undefined;
  #connectedPreparation: Generator<void, readonly string[]> | undefined;
  #nextLane = 0;
  #snapshotSource: readonly string[] | undefined;
  #snapshots: readonly string[] = [];
  #envelope: Bounds | undefined;
  #request: Parameters<ProgressiveElementPreview["set"]>[0] | undefined;
  #selection: PreviewSelection | undefined;

  public constructor(
    private readonly content: SceneContentRenderer,
    store: SceneStorePort,
  ) {
    this.#store = store;
    this.immediate = new SceneElementPreviewController(content);
    this.progressive = new ProgressiveElementPreview(content);
    this.#connected = new ProgressiveElementPreview(content, 0);
    this.#progressiveValues = new PreviewElementMap(
      this.progressive.values,
      this.#connected.values,
    );
    this.#values = new PreviewElementMap(this.immediate.values, this.#progressiveValues);
  }

  public selectProgressiveIds(
    ids: readonly string[],
    viewport: SceneViewport | undefined,
    camera: SceneCamera,
  ): readonly string[] {
    const prepared = this.content.selectionFeedbackIds?.(this.#request?.feedback);
    if (prepared !== undefined) return prepared;
    const previous = this.#selection;
    if (previous?.ids === ids && previous.viewport === viewport && previous.camera === camera) {
      return previous.selected;
    }
    const selected = this.#candidates.select(
      ids,
      this.content.previewMountedIds({
        transformBounds: this.#request?.feedback?.transformBounds,
        envelope: this.#envelope,
      }),
    );
    this.#selection = { camera, ids, selected, viewport };
    return selected;
  }

  public setProgressive(
    request: Parameters<ProgressiveElementPreview["set"]>[0],
    viewport: SceneViewport | undefined,
    camera: SceneCamera,
    purpose?: ProgressivePreviewPurpose,
  ): void {
    if (purpose === undefined && this.#purpose !== undefined) this.clearConnected();
    this.#purpose = purpose;
    this.#request = request;
    this.refreshProgressiveContext(viewport, camera);
  }

  public refreshProgressiveContext(
    viewport: SceneViewport | undefined,
    camera: SceneCamera,
    envelope = this.#envelope,
    membershipChanged = false,
  ): void {
    this.#envelope = envelope;
    if (membershipChanged) {
      this.#selection = undefined;
      this.#connectedSelection = undefined;
    }
    const request = this.#request;
    if (request === undefined) return;
    const ids =
      this.#purpose === "connected"
        ? NO_IDS
        : this.selectProgressiveIds(request.ids, viewport, camera);
    const snapshots =
      this.content.selectionFeedbackSnapshotIds?.(request.feedback) ?? this.snapshotIds(ids);
    const connected = this.connectedIds(request.ids, viewport, camera);
    this.progressive.set({
      ...request,
      ids: snapshots,
      feedbackIds: ids,
      isImmediate: this.#isImmediate,
      affineElement: request.feedback === undefined ? undefined : this.#affineElement,
    });
    if (this.#purpose !== undefined) {
      const source = typeof this.#purpose === "object" ? this.#purpose : request;
      this.#connected.set({
        ids: connected,
        materialize: this.#connectedCohort.materializer(source),
        version: request.version,
        connected: true,
        isImmediate: this.#isImmediate,
      });
    }
  }

  private connectedIds(
    ids: readonly string[],
    viewport: SceneViewport | undefined,
    camera: SceneCamera,
  ): readonly string[] {
    if (this.#purpose === undefined) return [];
    const source = typeof this.#purpose === "object" ? this.#purpose.ids : ids;
    const previous = this.#connectedSelection;
    if (previous?.ids === source) {
      this.#connectedSelection = { ...previous, viewport, camera };
      return previous.selected;
    }
    this.#connectedPreparation?.return([]);
    this.#connectedPreparation = this.#connectedCohort.select(source, () =>
      this.content.previewMountedIds(),
    );
    this.#connectedSelection = { ids: source, selected: NO_IDS, viewport, camera };
    return NO_IDS;
  }

  public get pending(): boolean {
    return (
      this.#connectedPreparation !== undefined ||
      this.progressive.pending ||
      this.#connected.pending
    );
  }

  public get hasValues(): boolean {
    return (
      this.immediate.values.size > 0 ||
      this.progressive.values.size > 0 ||
      this.#connected.values.size > 0
    );
  }

  public write(deadline: number, now: () => number, admittedFirstStep = false): boolean {
    const first = this.#nextLane;
    let stepped = false;
    for (let offset = 0; offset < 3; offset += 1) {
      if ((stepped || !admittedFirstStep) && now() >= deadline) break;
      const lane = (first + offset) % 3;
      if (lane === 0 && this.progressive.pending)
        this.progressive.write(deadline, now, admittedFirstStep && !stepped);
      else if (lane === 1 && this.#connected.pending)
        this.#connected.write(deadline, now, admittedFirstStep && !stepped);
      else if (lane === 2 && this.#connectedPreparation !== undefined)
        this.writeConnectedPreparation(deadline, now, admittedFirstStep && !stepped);
      else continue;
      this.#nextLane = (lane + 1) % 3;
      stepped = true;
    }
    return this.pending;
  }

  private writeConnectedPreparation(
    deadline: number,
    now: () => number,
    admittedFirstStep: boolean,
  ): void {
    let stepped = false;
    while (this.#connectedPreparation !== undefined) {
      if ((stepped || !admittedFirstStep) && now() >= deadline) return;
      const result = this.#connectedPreparation.next();
      stepped = true;
      if (!result.done) continue;
      this.#connectedPreparation = undefined;
      const selection = this.#connectedSelection!;
      this.#connectedSelection = { ...selection, selected: result.value };
      this.refreshProgressiveContext(selection.viewport, selection.camera);
    }
  }

  private snapshotIds(ids: readonly string[]): readonly string[] {
    if (ids === this.#snapshotSource) return this.#snapshots;
    const snapshots: string[] = [];
    let paths = 0;
    for (const id of ids) {
      const element = this.#store.get(id)?.element;
      if (element === undefined) continue;
      const cost =
        element.kind === "arrow"
          ? 1 + Number(isFilledNode(element.startNode)) + Number(isFilledNode(element.endNode))
          : 1;
      if (paths + cost > 256) break;
      snapshots.push(id);
      paths += cost;
    }
    this.#snapshotSource = ids;
    this.#snapshots = snapshots;
    return snapshots;
  }

  readonly #affineElement = (id: string): InkElementV1 | undefined => {
    const element = this.#store.get(id)?.element;
    return element?.kind === "stroke" && !element.style.pressureEnabled ? element : undefined;
  };

  readonly #isImmediate = (id: string): boolean => {
    const element = this.#store.get(id)?.element;
    return element !== undefined && element.kind !== "stroke";
  };

  public clearProgressive(): boolean {
    if (this.#request === undefined && this.#selection === undefined) return false;
    const changed = this.#request !== undefined;
    this.#request = undefined;
    this.#selection = undefined;
    this.#snapshotSource = undefined;
    this.#snapshots = [];
    this.clearConnected();
    this.#candidates.clear();
    this.progressive.clear();
    return changed;
  }

  public memoryUsage(): number {
    return (
      this.#candidates.memoryUsage() +
      this.#connectedCohort.memoryUsage() +
      this.#snapshots.length * 8 +
      this.progressive.memoryUsage() +
      this.#connected.memoryUsage() +
      this.content.previewMemoryUsage()
    );
  }

  public get values(): ReadonlyMap<string, InkElementV1> {
    if (this.progressive.values.size === 0 && this.#connected.values.size === 0)
      return this.immediate.values;
    if (this.immediate.values.size === 0) return this.#progressiveValues;
    return this.#values;
  }

  public retainCommittedGeometry(previews: ReadonlyMap<string, PreviewTransform>): void {
    this.content.materializePreviewGeometry(this.previewTransforms(previews), this.values);
  }

  public previewTransforms(
    previews: ReadonlyMap<string, PreviewTransform>,
  ): ReadonlyMap<string, PreviewTransform> {
    if (this.progressive.transforms.size === 0) return previews;
    if (previews.size === 0) return this.progressive.transforms;
    const transforms = new Map(previews);
    for (const [id, preview] of this.progressive.transforms) transforms.set(id, preview);
    return transforms;
  }

  public clear(): boolean {
    const immediate = this.immediate.clear();
    const progressive = this.clearProgressive();
    return immediate || progressive;
  }

  public release(): void {
    this.#request = undefined;
    this.#selection = undefined;
    this.#snapshotSource = undefined;
    this.#snapshots = [];
    this.clearConnected(true);
    this.#candidates.clear();
    this.immediate.release();
    this.progressive.release();
  }

  public applyMounted(ids: readonly string[]): void {
    this.immediate.applyMounted(ids);
    if (
      this.#request !== undefined &&
      ids.some((id) => this.#candidates.includes(id) || this.#connectedCohort.includes(id))
    ) {
      const selection = this.#selection ?? this.#connectedSelection;
      if (selection !== undefined) {
        this.#selection = undefined;
        this.#connectedSelection = undefined;
        this.refreshProgressiveContext(selection.viewport, selection.camera);
      }
    }
    this.progressive.applyMounted(ids);
    this.#connected.applyMounted(ids);
  }

  private clearConnected(release = false): void {
    if (release) this.#connected.release();
    else this.#connected.clear();
    this.#purpose = undefined;
    this.#connectedSelection = undefined;
    this.#connectedPreparation?.return([]);
    this.#connectedPreparation = undefined;
    this.#connectedCohort.clear();
  }
}

function isFilledNode(node: string): boolean {
  return node === "triangle" || node === "diamond" || node === "circle";
}
