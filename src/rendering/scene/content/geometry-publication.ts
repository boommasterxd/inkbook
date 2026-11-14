import type { SvgPathPart } from "../../../domain/geometry/element-path";
import type { InkElementV1 } from "../../../domain/schema/public";
import { CommittedPreviewGeometry } from "../presentation/committed-preview-geometry";
import type { SceneSelectionRuns } from "../presentation/selection-runs";
import type { SceneSelectionTraces } from "../presentation/selection-traces";
import type { ScenePublicationBudget } from "../reconciliation/mount-slice";
import type { PreviewTransform } from "../reconciliation/scene-visibility-reconciler";
import type { SceneDom } from "../scene-dom";
import type {
  MutableSceneInstrumentation,
  SceneDeltaEntry,
  SceneElementRecord,
  SceneStorePort,
} from "../types";
import { writeDirtySet } from "./dirty-set-work";
import {
  updateMountedGeometry,
  updatePreviewTransform,
  retainTextScaleFeedback,
  type MountedSceneElement,
} from "./mounted-element";
import type { ScenePathCache } from "./path-cache";
import { readCanonicalStrokePath } from "./stroke-position";
import { mountedGeometryPath } from "./mounted-geometry-path";
import { publishMountedPaint } from "./mounted-paint-publication";
import { TextPreviewPublication } from "./text-preview-publication";
import * as preview from "./element-preview-publication";
const EMPTY_IDS: readonly string[] = Object.freeze([]);
interface GeometryPublicationPorts {
  readonly onTextPublished?: (id: string) => void;
  readonly prepareGeometry: (
    record: SceneElementRecord,
    deadline: number,
    now: () => number,
    preemptLocal: boolean,
  ) => readonly SvgPathPart[] | undefined;
  readonly waitingForPaths: () => boolean;
  readonly releaseGeometry: (id: string, version?: number) => void;
  readonly dom: SceneDom;
  readonly mounted: ReadonlyMap<string, MountedSceneElement>;
  readonly store: SceneStorePort;
  readonly pathCache: ScenePathCache;
  readonly instrumentation: MutableSceneInstrumentation;
  readonly selectionRuns: SceneSelectionRuns;
  readonly selectionTraces: SceneSelectionTraces;
}
/** Owns mounted dirty queues and canonical geometry publication under one shared deadline. */
export class SceneGeometryPublication {
  readonly #selectionDirty = new Set<string>();
  readonly #geometryDirty = new Set<string>();
  readonly #ordinaryGeometryDirty = new Set<string>();
  readonly #paintDirty = new Set<string>();
  readonly #committedGeometry = new CommittedPreviewGeometry();
  readonly #deferredPreviews = new Set<string>();
  #committedPreviewIds: string[] = [];
  #preferGroupGeometry = false;
  #waitingForPaths = false;
  readonly #ports: GeometryPublicationPorts;
  readonly #textPreviews: TextPreviewPublication;

  public constructor(ports: GeometryPublicationPorts) {
    this.#ports = ports;
    this.#textPreviews = new TextPreviewPublication(ports.mounted, ports.store);
  }
  public retain(entry: MountedSceneElement): void {
    if (!this.#ports.selectionRuns.needsVisibleGeometry(entry)) return;
    this.#geometryDirty.add(entry.id);
    if (this.#ports.selectionRuns.canWriteVisibleGeometry(entry))
      this.#ordinaryGeometryDirty.add(entry.id);
  }
  public markSelectionDirty(ids?: readonly string[]): void {
    this.#ports.selectionTraces.markMountedDirty(this.#ports.mounted, this.#selectionDirty, ids);
  }
  public get waitingForPaths(): boolean {
    return (
      this.#waitingForPaths &&
      !this.#textPreviews.pending &&
      this.#paintDirty.size === 0 &&
      this.#selectionDirty.size === 0 &&
      (!this.#ports.selectionRuns.pending || this.#ports.selectionRuns.committing)
    );
  }
  public get hasPendingTextPreviews(): boolean {
    return this.#textPreviews.pending;
  }
  public *upcomingGeometryIds(): Iterable<string> {
    for (const id of this.#geometryDirty) if (this.retainsGeometryPath(id)) yield id;
  }
  public retainsGeometryPath(id: string): boolean {
    if (!this.#geometryDirty.has(id) || !this.#ports.mounted.has(id)) return false;
    const live = this.#ports.store.get(id);
    return (
      live?.element.kind === "stroke" &&
      (this.#ports.selectionRuns.canonicalTarget(id)?.geometryVersion ?? live.geometryVersion) ===
        live.geometryVersion
    );
  }
  public unmounted(id: string): void {
    this.#textPreviews.cancel(id);
    this.#geometryDirty.delete(id);
    this.#ordinaryGeometryDirty.delete(id);
    this.#paintDirty.delete(id);
    this.#selectionDirty.delete(id);
    this.#committedGeometry.finish(id);
    this.#deferredPreviews.delete(id);
  }
  public get hasSelectionWork(): boolean {
    return this.#selectionDirty.size > 0;
  }
  public get hasGeometryWork(): boolean {
    return this.#geometryDirty.size > 0;
  }
  public memoryUsage(): number {
    return (
      this.#committedGeometry.memoryUsage() +
      this.#textPreviews.memoryUsage() +
      (this.#deferredPreviews.size + this.#committedPreviewIds.length) * 8
    );
  }
  public release(): void {
    this.#textPreviews.release();
    this.#committedGeometry.release();
    this.#deferredPreviews.clear();
    this.#committedPreviewIds = [];
    this.#geometryDirty.clear();
    this.#ordinaryGeometryDirty.clear();
    this.#paintDirty.clear();
    this.#selectionDirty.clear();
  }
  public markGeometry(id: string, change?: SceneDeltaEntry): void {
    this.#textPreviews.canonical(id);
    if (change !== undefined) this.#ports.selectionRuns.capture(id, change);
    this.#ports.selectionRuns.geometryChanged(id, change);
    if (this.#ports.mounted.has(id)) this.#geometryDirty.add(id);
    if (!this.#ports.selectionRuns.grouped(id)) this.#ordinaryGeometryDirty.add(id);
    this.#ports.pathCache.invalidate(id);
  }
  public markPaint(id: string): void {
    this.#textPreviews.canonical(id);
    this.#ports.selectionRuns.invalidate();
    this.#paintDirty.add(id);
  }
  public materializePreviewGeometry(
    previews: ReadonlyMap<string, PreviewTransform>,
    elements: ReadonlyMap<string, InkElementV1>,
  ): void {
    const grouped = this.#ports.selectionRuns.retainCommit();
    this.#committedGeometry.retainPreviews(
      grouped ? this.#ports.selectionRuns.exceptionTransforms() : previews,
      grouped ? this.#ports.selectionRuns.exceptionElements(elements) : elements,
      {
        dirty: this.#geometryDirty,
        mounted: this.#ports.mounted,
      },
    );
  }
  public takeCommittedPreviewIds(): readonly string[] {
    if (this.#committedPreviewIds.length === 0) return EMPTY_IDS;
    const ids = this.#committedPreviewIds;
    this.#committedPreviewIds = [];
    return ids;
  }
  public writeMountedChanges(
    deadline: number,
    now: () => number,
    publication: ScenePublicationBudget,
    admittedFirstStep = false,
  ): boolean {
    this.#waitingForPaths = false;
    const groupFirst = this.#preferGroupGeometry;
    if (this.#ports.selectionRuns.committing) this.#preferGroupGeometry = !groupFirst;
    if (
      this.#ports.selectionRuns.committing &&
      !groupFirst &&
      this.#ordinaryGeometryDirty.size > 0 &&
      (admittedFirstStep || now() < deadline)
    ) {
      this.writeOrdinaryGeometry(deadline, now, publication);
      admittedFirstStep = false;
    }
    const runAdmission = this.#ports.selectionRuns.committing && admittedFirstStep;
    if (this.#ports.selectionRuns.committing) admittedFirstStep = false;
    if (
      this.#ports.selectionRuns.committing &&
      (runAdmission || now() < deadline) &&
      this.#ports.selectionRuns.normalize(
        deadline,
        now,
        (id, skipGeometry) => this.normalizeGeometry(id, skipGeometry, deadline, now, publication),
        runAdmission,
      )
    ) {
      if (now() < deadline && this.#ordinaryGeometryDirty.size > 0)
        this.writeOrdinaryGeometry(deadline, now, publication);
      if (this.#waitingForPaths && now() < deadline)
        this.writeAuxiliaryChanges(deadline, now, publication);
      return true;
    }
    if (this.#ports.selectionRuns.committing) return true;
    return this.writeRemainingChanges(deadline, now, publication, admittedFirstStep);
  }
  private writeOrdinaryGeometry(
    deadline: number,
    now: () => number,
    publication: ScenePublicationBudget,
  ): void {
    writeDirtySet(this.#ordinaryGeometryDirty, deadline, now, (id) => {
      if (!this.writeGeometry(id, deadline, now, publication)) return false;
      this.#geometryDirty.delete(id);
      return true;
    });
  }
  private normalizeGeometry(
    id: string,
    skipGeometry: boolean | undefined,
    deadline: number,
    now: () => number,
    publication: ScenePublicationBudget,
  ): boolean {
    if (skipGeometry) {
      this.#geometryDirty.delete(id);
      this.#ordinaryGeometryDirty.delete(id);
      return true;
    }
    if (!this.writeGeometry(id, deadline, now, publication)) return false;
    const entry = this.#ports.mounted.get(id);
    if (entry !== undefined) {
      updatePreviewTransform(
        entry,
        null,
        Number.MAX_SAFE_INTEGER,
        null,
        this.#ports.instrumentation,
      );
      this.#ports.selectionTraces.transform(id, entry);
    }
    this.#geometryDirty.delete(id);
    return true;
  }
  private writeRemainingChanges(
    deadline: number,
    now: () => number,
    publication: ScenePublicationBudget,
    admittedFirstStep: boolean,
  ): boolean {
    if (now() >= deadline && !admittedFirstStep) return this.hasMountedWork;
    let geometryPending = false;
    if (this.#geometryDirty.size > 0) {
      if (!this.#ports.selectionRuns.cleanupInactive(deadline, now)) return true;
      geometryPending = writeDirtySet(this.#geometryDirty, deadline, now, (id) =>
        this.writeGeometry(id, deadline, now, publication),
      );
      if (geometryPending && !this.#waitingForPaths) return true;
      if (now() >= deadline) return this.hasMountedWork;
    }
    const auxiliaryPending = this.writeAuxiliaryChanges(deadline, now, publication);
    return geometryPending || auxiliaryPending;
  }
  private writeAuxiliaryChanges(
    deadline: number,
    now: () => number,
    publication: ScenePublicationBudget,
  ): boolean {
    if (this.#textPreviews.pending) {
      const ids = this.#committedPreviewIds;
      if (
        this.#textPreviews.write(deadline, now, ids, ({ element, parts }) =>
          this.applyCanonicalElementPreview(element, parts),
        )
      )
        return true;
      if (now() >= deadline) return this.hasMountedWork;
    }
    if (this.#paintDirty.size > 0) {
      const context = {
        instrumentation: this.#ports.instrumentation,
        runs: this.#ports.selectionRuns,
        traces: this.#ports.selectionTraces,
        store: this.#ports.store,
        mounted: this.#ports.mounted,
        publication,
        deadline,
        now,
        onTextPublished: this.#ports.onTextPublished,
        markSelectionDirty: (key: string) => this.#selectionDirty.add(key),
      };
      if (writeDirtySet(this.#paintDirty, deadline, now, (id) => publishMountedPaint(id, context)))
        return true;
      if (now() >= deadline) return this.hasMountedWork;
    }
    const tracesPending = this.#ports.selectionTraces.writeDirty(
      this.#selectionDirty,
      this.#ports.mounted,
      this.#ports.store,
      deadline,
      now,
      publication,
    );
    if (tracesPending) return true;
    return this.#ports.selectionRuns.prepare(deadline, now, publication);
  }
  public get hasMountedWork(): boolean {
    return (
      this.#geometryDirty.size > 0 ||
      this.#textPreviews.pending ||
      this.#paintDirty.size > 0 ||
      this.#selectionDirty.size > 0 ||
      this.#ports.selectionRuns.pending
    );
  }
  public applyPreviewTransform(
    id: string,
    transform: string | null,
    version: number,
    strokeWidthScale: number | null,
    matrix?: PreviewTransform["matrix"],
    textBasis?: PreviewTransform["textBasis"],
  ): void {
    const entry = this.#ports.mounted.get(id);
    if (entry !== undefined) {
      retainTextScaleFeedback(entry, textBasis, matrix);
      if (
        this.#ports.selectionRuns.applyTransform(
          entry,
          version,
          transform,
          strokeWidthScale,
          matrix,
        )
      ) {
        this.#ports.selectionTraces.transform(id, entry);
        return;
      }
      const request = { transform, version, strokeWidthScale, matrix };
      const resolved = this.#committedGeometry.resolve(id, request);
      updatePreviewTransform(
        entry,
        resolved.transform,
        resolved.version,
        resolved.strokeWidthScale,
        this.#ports.instrumentation,
        resolved.matrix,
      );
      this.#ports.selectionTraces.transform(id, entry);
    }
  }
  private previewEntry(id: string): MountedSceneElement | undefined {
    if (
      this.#committedGeometry.has(id) ||
      (this.#ports.selectionRuns.committing && this.#ports.selectionRuns.grouped(id))
    ) {
      this.#deferredPreviews.add(id);
      return undefined;
    }
    return this.#ports.mounted.get(id);
  }
  public applyElementPreview(element: InkElementV1): boolean {
    const entry = this.previewEntry(element.id);
    if (entry === undefined) return false;
    return this.applyCanonicalElementPreview(element, preview.elementParts(entry, element));
  }
  public readCanonicalStrokePath(element: InkElementV1): readonly SvgPathPart[] | undefined {
    return readCanonicalStrokePath(element, this.#ports.mounted.get(element.id));
  }
  public applyCanonicalElementPreview(
    element: InkElementV1,
    parts: readonly SvgPathPart[],
  ): boolean {
    const entry = this.previewEntry(element.id);
    if (entry === undefined) return false;
    const record = this.#ports.store.get(element.id);
    if (record === undefined) return false;
    if (this.#ports.selectionRuns.needsVisibleGeometry(entry)) {
      this.#deferredPreviews.add(element.id);
      return false;
    }
    if (this.#textPreviews.defer(entry, element, parts)) return true;
    if (preview.publish(entry, record, element, parts, this.#ports))
      this.#selectionDirty.delete(element.id);
    else this.#selectionDirty.add(element.id);
    return true;
  }
  public clearElementPreview(id: string): void {
    this.#textPreviews.cancel(id);
    if (
      (this.#ports.selectionRuns.committing && this.#ports.selectionRuns.grouped(id)) ||
      this.#committedGeometry.has(id)
    ) {
      this.#geometryDirty.add(id);
      return;
    }
    const entry = this.#ports.mounted.get(id);
    if (entry === undefined) return;
    const record = this.#ports.store.get(id);
    if (record === undefined) return;
    if (record.element.kind === "text") {
      this.applyCanonicalElementPreview(record.element, entry.pathParts);
      return;
    }
    const parts = preview.restoreParts(entry, record, this.#ports.pathCache);
    if (parts === undefined) {
      this.#geometryDirty.add(id);
      return;
    }
    this.updateGeometry(entry, record, parts);
  }
  private writeGeometry(
    id: string,
    deadline: number,
    now: () => number,
    publication: ScenePublicationBudget,
  ): boolean {
    this.#waitingForPaths = false;
    const entry = this.#ports.mounted.get(id);
    const liveRecord = this.#ports.store.get(id);
    const record = this.#ports.selectionRuns.canonicalTarget(id) ?? liveRecord;
    if (entry === undefined || record === undefined) {
      this.#ports.releaseGeometry(id);
      this.unmounted(id);
      return true;
    }
    const liveDesired = this.#ports.selectionRuns.pendingPreview(id);
    if (entry.geometryVersion === record.geometryVersion) {
      this.#ports.selectionRuns.update(entry, record);
      this.#ports.selectionTraces.transform(id, entry);
      this.finishGeometryPublication(record, liveDesired);
      return true;
    }
    const currentVersion = liveRecord?.geometryVersion === record.geometryVersion;
    if (
      record.element.kind === "text" &&
      this.#ports.prepareGeometry(record, deadline, now, true) === undefined
    )
      return false;
    const pressure = currentVersion
      ? this.#ports.store.pressureGeometry?.(record.id, record.geometryVersion)
      : undefined;
    const canonicalStroke = record.element.kind === "stroke" && currentVersion;
    const parts = mountedGeometryPath(entry, record, {
      currentVersion,
      pressure,
      deadline,
      now,
      retained: this.#committedGeometry,
      runs: this.#ports.selectionRuns,
      paths: this.#ports.pathCache,
      prepare: this.#ports.prepareGeometry,
    });
    if (parts === undefined) {
      this.#waitingForPaths = canonicalStroke && this.#ports.waitingForPaths();
      return false;
    }
    this.updateGeometry(entry, record, parts, publication);
    this.finishGeometryPublication(record, liveDesired);
    return true;
  }
  private finishGeometryPublication(
    record: SceneElementRecord,
    liveDesired: PreviewTransform | undefined,
  ): void {
    const { id, geometryVersion } = record;
    this.#ports.releaseGeometry(id, geometryVersion);
    this.#ordinaryGeometryDirty.delete(id);
    const retainedDesired = this.#committedGeometry.finish(id);
    const desired = liveDesired ?? retainedDesired;
    if (this.#deferredPreviews.delete(id)) this.#committedPreviewIds.push(id);
    if (desired !== undefined)
      this.applyPreviewTransform(
        id,
        desired.transform,
        desired.version,
        desired.strokeWidthScale,
        desired.matrix,
        desired.textBasis,
      );
  }
  private updateGeometry(
    entry: MountedSceneElement,
    record: SceneElementRecord,
    parts: readonly SvgPathPart[],
    publication?: ScenePublicationBudget,
  ): void {
    const geometryChanged = entry.geometryVersion !== record.geometryVersion;
    if (geometryChanged && !this.#ports.pathCache.has(record.id, record.geometryVersion))
      this.#ports.pathCache.completePreparation(record.element, parts, record.geometryVersion);
    updateMountedGeometry(
      entry,
      record,
      parts,
      this.#ports.dom.ownerDocument,
      this.#ports.dom.group(entry.band),
      this.#ports.instrumentation,
    );
    if (entry.text !== undefined) this.#ports.onTextPublished?.(entry.id);
    this.#ports.selectionRuns.update(entry, record);
    if (this.#ports.selectionTraces.update(entry, record.element, parts, publication))
      this.#selectionDirty.delete(entry.id);
    else this.#selectionDirty.add(entry.id);
  }
}
