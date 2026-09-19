import type { SvgPathPart } from "../../domain/geometry/element-path";
import type { InkElementV1 } from "../../domain/schema/public";
import { SelectionHaloLayer } from "./selection-halo-layer";
import { SelectionHalo, type SelectionHaloContext } from "./selection-halo";
import type { MountedSceneElement } from "./mounted-element";
import type { MutableSceneInstrumentation } from "./types";

interface SelectionTrace {
  readonly halo: SelectionHalo;
  element: InkElementV1;
  parts: readonly SvgPathPart[];
  haloEnabled: boolean;
}

/** Retains only mounted selection paths; content updates own their invalidation. */
export class SceneSelectionTraces {
  readonly #group: SVGGElement;
  readonly #instrumentation: MutableSceneInstrumentation;
  readonly #traces = new Map<string, SelectionTrace>();
  #bytes = 0;
  #haloCount = 0;
  #layer: SelectionHaloLayer | undefined;
  #contextDirty = false;
  #context: SelectionHaloContext = { camera: { x: 0, zoom: 1 }, viewport: undefined };
  #highlightsEnabled = true;
  #selected: ReadonlySet<string> = new Set();

  public constructor(group: SVGGElement, instrumentation: MutableSceneInstrumentation) {
    this.#group = group;
    this.#instrumentation = instrumentation;
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
    return true;
  }

  public setSelection(selected: ReadonlySet<string>): boolean {
    if (selected === this.#selected) return false;
    this.#selected = selected;
    return true;
  }

  public memoryUsage(): number {
    return this.#bytes + (this.#layer?.memoryUsage() ?? 0);
  }

  public setContext(context: SelectionHaloContext): void {
    this.#context = context;
    this.#contextDirty = true;
  }

  public flushContext(): void {
    if (!this.#contextDirty) return;
    this.#contextDirty = false;
    this.#layer?.setContext(this.#context);
    for (const trace of this.#traces.values()) {
      const before = trace.halo.memoryUsage();
      trace.halo.setContext(this.#context);
      this.#bytes += trace.halo.memoryUsage() - before;
    }
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
      trace = {
        halo: new SelectionHalo(this.#group, entry, this.#context, this.#instrumentation),
        element,
        parts,
        haloEnabled: false,
      };
      this.#traces.set(entry.id, trace);
      this.#bytes += trace.halo.memoryUsage();
    } else if (
      trace.parts === parts &&
      trace.element === element &&
      trace.haloEnabled === this.#highlightsEnabled
    ) {
      this.transform(entry.id, entry);
      return;
    }
    const before = trace.halo.memoryUsage();
    trace.halo.update(entry, element, parts, this.#highlightsEnabled ? this.haloLayer() : null);
    this.#haloCount += Number(this.#highlightsEnabled) - Number(trace.haloEnabled);
    trace.haloEnabled = this.#highlightsEnabled;
    this.releaseUnusedLayer();
    this.#bytes += trace.halo.memoryUsage() - before;
    trace.element = element;
    trace.parts = parts;
  }

  public transform(id: string, entry: MountedSceneElement): void {
    const trace = this.#traces.get(id);
    if (trace === undefined) return;
    const before = trace.halo.memoryUsage();
    trace.halo.transform(entry.appliedPreviewTransform, entry.previewStrokeWidthScale);
    this.#bytes += trace.halo.memoryUsage() - before;
  }

  public prune(mounted: ReadonlyMap<string, MountedSceneElement>): void {
    for (const id of this.#traces.keys()) {
      if (!mounted.has(id) || !this.#selected.has(id)) this.remove(id);
    }
  }

  public release(): void {
    for (const id of this.#traces.keys()) this.remove(id);
    this.#selected = new Set();
  }

  private haloLayer(): SVGGElement {
    if (this.#layer === undefined) {
      const first = this.#traces.values().next().value?.halo.node ?? null;
      this.#layer = new SelectionHaloLayer(this.#group, this.#instrumentation, first);
      this.#layer.setContext(this.#context);
    }
    return this.#layer.node;
  }

  private releaseUnusedLayer(): void {
    if (this.#haloCount !== 0) return;
    this.#layer?.release();
    this.#layer = undefined;
  }

  private remove(id: string): void {
    const trace = this.#traces.get(id);
    if (trace === undefined) return;
    this.#bytes -= trace.halo.memoryUsage();
    this.#haloCount -= Number(trace.haloEnabled);
    trace.halo.release();
    this.releaseUnusedLayer();
    this.#traces.delete(id);
  }
}
