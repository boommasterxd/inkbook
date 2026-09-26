import type { SvgPathPart } from "../../domain/geometry/element-path";
import type { InkElementV1 } from "../../domain/schema/public";
import { SelectionCenterCache } from "./selection-center-cache";
import { SelectionCenterTrace } from "./selection-center-trace";
import type { MountedSceneElement } from "./mounted-element";
import type { MutableSceneInstrumentation } from "./types";

/** Retains only mounted center indicators, with camera-independent geometry and paint. */
export class SceneSelectionTraces {
  readonly #group: SVGGElement;
  readonly #frame: SVGPathElement;
  readonly #instrumentation: MutableSceneInstrumentation;
  readonly #traces = new Map<string, SelectionCenterTrace>();
  readonly #cache = new SelectionCenterCache();
  #bytes = 0;
  #selectionDirty = false;
  #highlightsEnabled = true;
  #selected: ReadonlySet<string> = new Set();
  #suppressFrameOutline = false;

  public constructor(
    group: SVGGElement,
    instrumentation: MutableSceneInstrumentation,
    frame: SVGPathElement,
  ) {
    this.#group = group;
    this.#instrumentation = instrumentation;
    this.#frame = frame;
  }
  public needsUpdate(id: string, element?: InkElementV1): boolean {
    return this.#traces.has(id) || (element !== undefined && this.includes(element));
  }
  public includes(element: InkElementV1): boolean {
    return (
      this.#selected.has(element.id) &&
      (this.#highlightsEnabled || element.kind === "line" || element.kind === "arrow")
    );
  }

  public setHighlightsEnabled(enabled: boolean): boolean {
    if (enabled === this.#highlightsEnabled) return false;
    this.#highlightsEnabled = enabled;
    this.syncFrameOutline();
    return true;
  }
  public setSelection(selected: ReadonlySet<string>): boolean {
    if (selected === this.#selected) return false;
    this.#selected = selected;
    this.#selectionDirty = true;
    this.syncFrameOutline();
    return true;
  }
  public memoryUsage(): number {
    return this.#bytes + this.#cache.memoryUsage();
  }
  public flushContext(): void {
    if (!this.#selectionDirty) return;
    this.#selectionDirty = false;
    for (const id of this.#traces.keys()) if (!this.#selected.has(id)) this.remove(id);
  }

  public update(
    entry: MountedSceneElement,
    element: InkElementV1,
    parts: readonly SvgPathPart[],
  ): void {
    if (!this.includes(element)) {
      this.remove(entry.id);
      return;
    }
    let trace = this.#traces.get(entry.id);
    if (trace === undefined) {
      trace = new SelectionCenterTrace(this.#group, entry, this.#instrumentation, this.#cache);
      this.#traces.set(entry.id, trace);
      this.#bytes += trace.memoryUsage();
    }
    const before = trace.memoryUsage();
    trace.update(entry, element, parts);
    this.#bytes += trace.memoryUsage() - before;
    this.syncFrameOutline();
  }

  public transform(id: string, entry: MountedSceneElement): void {
    const center = this.#traces.get(id);
    if (center === undefined) return;
    const before = center.memoryUsage();
    center.transform(entry.appliedPreviewTransform);
    this.#bytes += center.memoryUsage() - before;
  }
  public prune(mounted: ReadonlyMap<string, MountedSceneElement>): void {
    for (const id of this.#traces.keys())
      if (!mounted.has(id) || !this.#selected.has(id)) this.remove(id);
  }
  public release(): void {
    for (const trace of this.#traces.values()) trace.release();
    this.#traces.clear();
    this.#cache.clear();
    this.#selected = new Set();
    this.#selectionDirty = false;
    this.#bytes = 0;
    this.syncFrameOutline();
  }
  private remove(id: string): void {
    const trace = this.#traces.get(id);
    if (trace === undefined) return;
    this.#bytes -= trace.memoryUsage();
    trace.release();
    this.#traces.delete(id);
    this.syncFrameOutline();
  }
  private syncFrameOutline(): void {
    const id = this.#selected.size === 1 ? this.#selected.values().next().value : undefined;
    const suppress =
      this.#highlightsEnabled &&
      id !== undefined &&
      this.#traces.get(id)?.elementKind === "rectangle";
    if (suppress === this.#suppressFrameOutline) return;
    this.#suppressFrameOutline = suppress;
    this.#frame.setAttribute("data-center-outline", String(suppress));
    this.#instrumentation.attributeWrites += 1;
  }
}
