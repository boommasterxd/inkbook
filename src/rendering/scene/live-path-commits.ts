import { SVG_NAMESPACE } from "./constants";
import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";
import type { AppliedLivePath } from "./frame-writes";
import type { SceneDom } from "./scene-dom";

/** Retains exact staged paths until their committed counterparts are mounted. */
export class SceneLivePathCommits {
  readonly #groups = new Map<string, SVGGElement>();

  public constructor(private readonly dom: SceneDom) {}

  public assertAvailable(id: string): void {
    if (this.#groups.has(id) || this.#groups.size >= FILE_SCHEMA_LIMITS.elements) {
      throw new RangeError("Live path handoffs must have unique, document-bounded IDs.");
    }
  }

  public retain(id: string, applied: AppliedLivePath): void {
    if (applied.parts.length === 0) return;
    const group = this.dom.ownerDocument.createElementNS(SVG_NAMESPACE, "g");
    group.setAttribute("pointer-events", "none");
    for (const { node } of applied.parts) group.append(node);
    this.dom.group(applied.band).append(group);
    this.#groups.set(id, group);
    this.dom.replaceLivePath();
  }

  public settle(done: (id: string) => boolean): void {
    for (const [id, group] of this.#groups) {
      if (!done(id)) continue;
      group.remove();
      this.#groups.delete(id);
    }
  }
}
