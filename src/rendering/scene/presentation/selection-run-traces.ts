import { SVG_NAMESPACE } from "../constants";
import type { MountedSceneElement } from "../content/mounted-element";
import type { ScenePublicationBudget } from "../reconciliation/mount-slice";
import type { MutableSceneInstrumentation } from "../types";
import { writeRunTransform } from "./selection-run-groups";

/** Physical parents only. Cached trace transforms stay with SelectionCenterTrace. */
export class SelectionRunTraces {
  #suffix: SVGGElement | undefined;
  #prefix: SVGGElement | undefined;
  #transform: string | null = null;
  #prefixTransform: string | null = null;
  public constructor(
    private readonly options: {
      readonly container: SVGGElement;
      readonly node: (id: string) => SVGElement | undefined;
      readonly instrumentation: MutableSceneInstrumentation;
    },
  ) {}
  public prepare(
    deadline: number,
    now: () => number,
    publication: ScenePublicationBudget,
  ): boolean {
    if (this.#suffix === undefined) {
      if (now() >= deadline || publication.remainingRoots < 1) return false;
      this.#suffix = this.group();
      this.options.container.append(this.#suffix);
      publication.remainingRoots -= 1;
    }
    if (this.#prefix === undefined) {
      if (now() >= deadline || publication.remainingRoots < 1) return false;
      this.#prefix = this.group();
      this.options.container.insertBefore(this.#prefix, this.#suffix);
      publication.remainingRoots -= 1;
    }
    return true;
  }
  private group(): SVGGElement {
    const group = this.options.container.ownerDocument.createElementNS(SVG_NAMESPACE, "g");
    this.options.instrumentation.domRootsPublished += 1;
    return group;
  }
  public member(entry: MountedSceneElement, canonical = false): void {
    const node = this.options.node(entry.id),
      parent = canonical ? this.#prefix : this.#suffix;
    if (node === undefined || parent === undefined || node.parentNode === parent) return;
    parent.append(node);
    this.options.instrumentation.domReorders += 1;
  }
  public publish(transform: string | null): void {
    this.publishBases(null, transform);
  }
  public publishBases(prefix: string | null, suffix: string | null): void {
    if (this.#prefix !== undefined && prefix !== this.#prefixTransform) {
      this.writeTransform(this.#prefix, prefix);
      this.#prefixTransform = prefix;
    }
    if (this.#suffix !== undefined && suffix !== this.#transform) {
      this.writeTransform(this.#suffix, suffix);
      this.#transform = suffix;
    }
  }
  private writeTransform(node: SVGGElement, transform: string | null): void {
    writeRunTransform(node, transform, this.options.instrumentation);
    this.options.instrumentation.selectionTraceAttributeWrites += 1;
  }
  public releaseMember(entry: MountedSceneElement): void {
    const node = this.options.node(entry.id);
    if (
      node === undefined ||
      (node.parentNode !== this.#suffix && node.parentNode !== this.#prefix)
    )
      return;
    this.options.container.append(node);
    this.options.instrumentation.domReorders += 1;
  }
  public finishCommit(): void {
    if (this.#suffix !== undefined && this.#suffix.hasChildNodes())
      throw new Error("Selection trace normalization is incomplete.");
    const empty = this.#suffix!;
    if (this.#transform !== null) this.writeTransform(empty, null);
    this.options.container.insertBefore(empty, this.#prefix!);
    this.options.instrumentation.domReorders += 1;
    this.#suffix = this.#prefix;
    this.#prefix = empty;
    this.#transform = this.#prefixTransform;
    this.#prefixTransform = null;
  }
  public cleanup(): void {
    if (this.#suffix?.hasChildNodes() === true || this.#prefix?.hasChildNodes() === true)
      throw new Error("Selection traces must be released cooperatively before their parent.");
    this.#suffix?.remove();
    this.#prefix?.remove();
    this.#suffix = undefined;
    this.#prefix = undefined;
    this.#transform = null;
  }
  public release(): void {
    this.#suffix?.remove();
    this.#prefix?.remove();
    this.#suffix = undefined;
    this.#prefix = undefined;
    this.#transform = null;
  }
  public memoryUsage(): number {
    return (
      (this.#suffix === undefined ? 0 : 512) +
      (this.#prefix === undefined ? 0 : 512) +
      (this.#transform?.length ?? 0) * 2
    );
  }
}
