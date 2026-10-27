import { strokeLocalGeometry } from "../../../domain/geometry/stroke-position";
import { isStoredStroke } from "../../../domain/elements/stroke-replacement-proof";
import { buildElementPathParts, type SvgPathPart } from "../../../domain/geometry/element-path";
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
  updateMountedElementPreview,
  updateMountedPaint,
  updatePreviewTransform,
  type MountedSceneElement,
} from "./mounted-element";
import type { ScenePathCache } from "./path-cache";
import { sameStrokeShape } from "./stroke-position";

const EMPTY_IDS: readonly string[] = Object.freeze([]);

interface GeometryPublicationPorts {
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
  readonly #ports: GeometryPublicationPorts;

  public constructor(ports: GeometryPublicationPorts) {
    this.#ports = ports;
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
  public get hasSelectionWork(): boolean {
    return this.#selectionDirty.size > 0;
  }
  public memoryUsage(): number {
    return (
      this.#committedGeometry.memoryUsage() +
      (this.#deferredPreviews.size + this.#committedPreviewIds.length) * 8
    );
  }
  public release(): void {
    this.#committedGeometry.release();
    this.#deferredPreviews.clear();
    this.#committedPreviewIds = [];
    this.#geometryDirty.clear();
    this.#ordinaryGeometryDirty.clear();
    this.#paintDirty.clear();
    this.#selectionDirty.clear();
  }
  public markGeometry(id: string, change?: SceneDeltaEntry): void {
    if (change !== undefined) this.#ports.selectionRuns.capture(id, change);
    this.#ports.selectionRuns.geometryChanged(id, change);
    if (this.#ports.mounted.has(id)) this.#geometryDirty.add(id);
    if (!this.#ports.selectionRuns.grouped(id)) this.#ordinaryGeometryDirty.add(id);
    this.#ports.pathCache.invalidate(id);
  }
  public markPaint(id: string): void {
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
    const groupFirst = this.#ports.selectionRuns.committing && this.#preferGroupGeometry;
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
    if (this.#geometryDirty.size > 0) {
      if (
        writeDirtySet(this.#geometryDirty, deadline, now, (id) =>
          this.writeGeometry(id, deadline, now, publication),
        )
      )
        return true;
      if (now() >= deadline) return this.hasMountedWork;
    }
    if (this.#paintDirty.size > 0) {
      if (writeDirtySet(this.#paintDirty, deadline, now, (id) => this.writePaint(id, publication)))
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
  ): void {
    const entry = this.#ports.mounted.get(id);
    if (entry !== undefined) {
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
      const resolved = this.#committedGeometry.resolve(id, {
        transform,
        version,
        strokeWidthScale,
        matrix,
      });
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
    const parts = sameStrokeShape(entry.displayedElement, element)
      ? entry.displayedPathParts
      : buildElementPathParts(element.kind === "stroke" ? strokeLocalGeometry(element) : element);
    return this.applyCanonicalElementPreview(element, parts);
  }
  public readCanonicalStrokePath(element: InkElementV1): readonly SvgPathPart[] | undefined {
    const entry = this.#ports.mounted.get(element.id);
    return element.kind === "stroke" &&
      (Object.isFrozen(element.points) || isStoredStroke(element)) &&
      entry !== undefined &&
      sameStrokeShape(entry.displayedElement, element)
      ? entry.displayedPathParts
      : undefined;
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
    updateMountedElementPreview(entry, record, element, parts, {
      instrumentation: this.#ports.instrumentation,
      ownerDocument: this.#ports.dom.ownerDocument,
      parent: this.#ports.dom.group(entry.band),
    });
    this.#ports.selectionRuns.update(entry);
    if (this.#ports.selectionTraces.update(entry, element, parts))
      this.#selectionDirty.delete(element.id);
    else this.#selectionDirty.add(element.id);
    return true;
  }
  public clearElementPreview(id: string): void {
    if (this.#ports.selectionRuns.committing && this.#ports.selectionRuns.grouped(id)) {
      this.#geometryDirty.add(id);
      return;
    }
    if (this.#committedGeometry.has(id)) {
      this.#geometryDirty.add(id);
      return;
    }
    const entry = this.#ports.mounted.get(id);
    if (entry === undefined) return;
    const record = this.#ports.store.get(id);
    if (record === undefined) return;
    if (
      entry.geometryVersion !== record.geometryVersion &&
      record.element.kind === "stroke" &&
      record.element.style.pressureEnabled
    ) {
      this.#geometryDirty.add(id);
      return;
    }
    const parts =
      entry.geometryVersion === record.geometryVersion
        ? entry.pathParts
        : this.#ports.pathCache.build(
            record.element,
            this.#ports.store.pressureGeometry?.(record.id, record.geometryVersion),
          );
    this.updateGeometry(entry, record, parts);
  }
  private writeGeometry(
    id: string,
    deadline: number,
    now: () => number,
    publication: ScenePublicationBudget,
  ): boolean {
    const entry = this.#ports.mounted.get(id);
    const liveRecord = this.#ports.store.get(id);
    const record = this.#ports.selectionRuns.canonicalTarget(id) ?? liveRecord;
    if (entry === undefined || record === undefined) {
      this.#committedGeometry.finish(id);
      this.#deferredPreviews.delete(id);
      this.#ordinaryGeometryDirty.delete(id);
      return true;
    }
    const liveDesired = this.#ports.selectionRuns.pendingPreview(id);
    if (entry.geometryVersion === record.geometryVersion) {
      this.#ports.selectionRuns.update(entry, record);
      this.#ports.selectionTraces.transform(id, entry);
      this.finishGeometryPublication(id, liveDesired);
      return true;
    }
    const pressure =
      liveRecord?.geometryVersion === record.geometryVersion
        ? this.#ports.store.pressureGeometry?.(record.id, record.geometryVersion)
        : undefined;
    const pending =
      this.#committedGeometry.has(id) ||
      (this.#ports.selectionRuns.committing && this.#ports.selectionRuns.grouped(id)) ||
      (record.element.kind === "stroke" && record.element.style.pressureEnabled);
    const parts =
      (sameStrokeShape(entry.displayedElement, record.element)
        ? entry.displayedPathParts
        : undefined) ??
      this.#ports.pathCache.read(record.element, pressure, record.geometryVersion) ??
      (pending
        ? this.#committedGeometry.prepare(record, deadline, now, pressure)
        : this.#ports.pathCache.build(record.element, pressure));
    if (parts === undefined) return false;
    this.updateGeometry(entry, record, parts, publication);
    this.finishGeometryPublication(id, liveDesired);
    return true;
  }
  private finishGeometryPublication(id: string, liveDesired: PreviewTransform | undefined): void {
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
    this.#ports.selectionRuns.update(entry, record);
    if (this.#ports.selectionTraces.update(entry, record.element, parts, publication))
      this.#selectionDirty.delete(entry.id);
    else this.#selectionDirty.add(entry.id);
  }
  private writePaint(id: string, publication: ScenePublicationBudget): void {
    const entry = this.#ports.mounted.get(id);
    const record = this.#ports.store.get(id);
    if (entry === undefined || record === undefined || entry.paintVersion === record.paintVersion)
      return;
    updateMountedPaint(entry, record, entry.pathParts, this.#ports.instrumentation);
    entry.displayedElement = record.element;
    this.#ports.selectionRuns.update(entry);
    if (
      !this.#ports.selectionTraces.update(
        entry,
        record.element,
        entry.displayedPathParts,
        publication,
      )
    )
      this.#selectionDirty.add(id);
  }
}
