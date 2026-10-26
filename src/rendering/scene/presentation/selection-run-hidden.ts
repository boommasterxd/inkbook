import type { MountedSceneElement } from "../content/mounted-element";
import type { MutableSceneInstrumentation } from "../types";
import type { PreviewTransform } from "../reconciliation/scene-visibility-reconciler";

/** Offscreen old geometry is not painted again before canonical readmission.
 * Visibility is separate from the existing transform, opacity and paint writers. */
export class SelectionRunHidden {
  #members = new Map<string, Map<SVGElement, string | null>>();
  #live = new Map<string, PreviewTransform>();
  #bytes = 0;
  public constructor(private readonly instrumentation: MutableSceneInstrumentation) {}

  public hide(entry: MountedSceneElement, trace: SVGElement | undefined): void {
    if (this.#members.has(entry.id)) return;
    const roots: SVGElement[] =
      entry.group === null ? entry.paths.map((path) => path.node) : [entry.group];
    const previous = new Map<SVGElement, string | null>();
    if (trace !== undefined) roots.push(trace);
    this.#bytes += 64 + entry.id.length * 2;
    for (const root of roots) {
      const value = root.getAttribute("visibility");
      previous.set(root, value);
      this.#bytes += 48 + 2 * (value?.length ?? 0);
      if (value !== "hidden") this.write(root, "hidden");
    }
    this.#members.set(entry.id, previous);
  }

  public show(id: string): void {
    const previous = this.#members.get(id);
    if (previous === undefined) return;
    for (const [root, value] of previous) {
      this.write(root, value);
      this.#bytes -= 48 + 2 * (value?.length ?? 0);
    }
    this.#bytes -= 64 + id.length * 2;
    this.#members.delete(id);
    this.dropPreview(id);
  }
  public preview(
    id: string,
    transform: string | null,
    version: number,
    strokeWidthScale: number | null,
    matrix: PreviewTransform["matrix"],
  ): void {
    if (!this.#members.has(id)) return;
    this.dropPreview(id);
    if (transform !== null) {
      this.#live.set(id, { transform, version, strokeWidthScale, matrix });
      this.#bytes += 96 + 2 * transform.length;
    }
  }
  public livePreview(id: string): PreviewTransform | undefined {
    return this.#live.get(id);
  }
  private dropPreview(id: string): void {
    const previous = this.#live.get(id);
    if (previous !== undefined) this.#bytes -= 96 + 2 * (previous.transform?.length ?? 0);
    this.#live.delete(id);
  }
  public discard(): void {
    this.#members = new Map();
    this.#live = new Map();
    this.#bytes = 0;
  }
  public memoryUsage(): number {
    return 64 + this.#bytes;
  }
  private write(root: SVGElement, value: string | null): void {
    if (value === null) root.removeAttribute("visibility");
    else root.setAttribute("visibility", value);
    this.instrumentation.attributeWrites += 1;
    this.instrumentation.contentAttributeWrites += 1;
  }
}
