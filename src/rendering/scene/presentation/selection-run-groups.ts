import { SVG_NAMESPACE } from "../constants";
import {
  appendElementToFragment,
  createFragment,
  firstPath,
  type MountedSceneElement,
} from "../content/mounted-element";
import type { SceneDom } from "../scene-dom";
import type { MutableSceneInstrumentation } from "../types";
import type { ScenePublicationBudget } from "../reconciliation/mount-slice";
import type { SelectionRankRun } from "./selection-run-plan";

export function writeRunTransform(
  node: SVGGElement,
  transform: string | null,
  instrumentation: MutableSceneInstrumentation,
): void {
  if (transform === null) node.removeAttribute("transform");
  else node.setAttribute("transform", transform);
  instrumentation.attributeWrites += 1;
}

interface OwnedRun {
  readonly plan: SelectionRankRun;
  prefix: SVGGElement | undefined;
  suffix: SVGGElement | undefined;
  prepared: number;
  canonical: number;
  released: number;
  frontierRank: number;
  transform: string | null;
  prefixTransform: string | null;
}
interface Options {
  readonly dom: Pick<SceneDom, "group" | "ownerDocument">;
  readonly instrumentation: MutableSceneInstrumentation;
  readonly paint?: (container: SVGGElement, active: boolean) => void;
}

/** Owns only physical run containers. Authoritative ordering remains in the store. */
export class SelectionRunGroups {
  #runs: OwnedRun[] = [];
  #membership = new Map<string, { readonly run: OwnedRun; readonly entry: MountedSceneElement }>();
  #fragment: DocumentFragment | undefined;
  #committing = false;
  #cleaning = false;
  #commitRun = 0;

  public constructor(private readonly options: Options) {}

  public get ready(): boolean {
    return (
      !this.#committing &&
      !this.#cleaning &&
      this.#runs.length > 0 &&
      this.#runs.every(
        (run) =>
          run.prefix !== undefined &&
          run.suffix !== undefined &&
          run.prepared === run.plan.entries.length,
      )
    );
  }

  /** At most two descriptors; member registration and all DOM work are deferred. */
  public begin(runs: readonly SelectionRankRun[]): void {
    if (this.#runs.length > 0) throw new Error("Clean up the previous selection runs first.");
    if (runs.length > 2 || new Set(runs.map((run) => run.band)).size !== runs.length)
      throw new Error("Selection runs require at most one interval per band.");
    this.#runs = runs
      .filter((run) => run.entries.length > 0)
      .map((plan) => ({
        plan,
        prefix: undefined,
        suffix: undefined,
        prepared: 0,
        canonical: 0,
        released: 0,
        frontierRank: -Infinity,
        transform: null,
        prefixTransform: null,
      }))
      .sort((left, right) => left.plan.firstRank - right.plan.firstRank);
  }

  public prepare(
    deadline: number,
    now: () => number,
    publication: ScenePublicationBudget,
    onPrepareEntry: (entry: MountedSceneElement) => unknown,
  ): boolean {
    if (this.#committing || this.#cleaning) return false;
    for (const run of this.#runs) {
      if (!this.prepareContainers(run, deadline, now, publication)) return false;
      while (run.prepared < run.plan.entries.length) {
        if (now() >= deadline) return false;
        const entry = run.plan.entries[run.prepared]!;
        if (onPrepareEntry(entry) === false) return false;
        this.move(entry, run.suffix!);
        this.#membership.set(entry.id, { run, entry });
        run.prepared += 1;
      }
    }
    return this.ready;
  }

  /** Pointer-frame work touches only the original suffixes, never their members. */
  public publish(transform: string | null): void {
    this.publishBases(null, transform);
  }
  public publishBases(prefix: string | null, suffix: string | null): void {
    for (const run of this.#runs) {
      if (run.prefix !== undefined && run.prefixTransform !== prefix) {
        this.writeTransform(run.prefix, prefix);
        this.options.paint?.(run.prefix, prefix !== null);
        run.prefixTransform = prefix;
      }
      if (run.suffix !== undefined && run.transform !== suffix) {
        this.writeTransform(run.suffix, suffix);
        this.options.paint?.(run.suffix, suffix !== null);
        run.transform = suffix;
      }
    }
  }
  private writeTransform(node: SVGGElement, transform: string | null): void {
    writeRunTransform(node, transform, this.options.instrumentation);
    this.options.instrumentation.contentAttributeWrites += 1;
    this.options.instrumentation.contentGeometryWrites += 1;
  }
  public parentTransform(entry: MountedSceneElement): string | null {
    const member = this.#membership.get(entry.id);
    if (member?.entry !== entry) return null;
    const run = member.run;
    return firstPath(entry).parentNode === run.prefix ? run.prefixTransform : run.transform;
  }
  public owns(entry: MountedSceneElement): boolean {
    return this.#membership.get(entry.id)?.entry === entry;
  }
  public inPrefix(entry: MountedSceneElement): boolean {
    return firstPath(entry).parentNode === this.#membership.get(entry.id)?.run.prefix;
  }

  public beginCommit(): void {
    if (!this.ready) throw new Error("Selection runs are not ready.");
    this.#committing = true;
    this.#commitRun = 0;
  }

  public get pendingCanonical(): MountedSceneElement | undefined {
    if (!this.#committing) return undefined;
    const run = this.#runs[this.#commitRun];
    return run?.plan.entries[run.canonical];
  }

  public next(): MountedSceneElement | undefined {
    return this.pendingCanonical;
  }

  /** The caller updates geometry and clears own transforms before this same unit. */
  public canonical(entry: MountedSceneElement): void {
    if (entry !== this.pendingCanonical) throw new Error("Canonical order must remain monotonic.");
    const run = this.#runs[this.#commitRun]!;
    this.move(entry, run.prefix!);
    run.frontierRank = entry.rank;
    run.canonical += 1;
    if (run.canonical === run.plan.entries.length) this.#commitRun += 1;
  }

  /** Constant run-count work; the next prepare admits replacement empty prefixes. */
  public finishCommit(): void {
    if (!this.#committing || this.pendingCanonical !== undefined)
      throw new Error("Canonical normalization is incomplete.");
    for (const run of this.#runs) {
      const empty = run.suffix!;
      if (run.transform !== null) this.writeTransform(empty, null);
      this.options.paint?.(empty, false);
      this.options.dom.group(run.plan.band).insertBefore(empty, run.prefix!);
      this.options.instrumentation.domReorders += 1;
      this.options.instrumentation.domFragmentRuns += 1;
      run.suffix = run.prefix;
      run.prefix = empty;
      run.canonical = 0;
      run.frontierRank = -Infinity;
      run.transform = run.prefixTransform;
      run.prefixTransform = null;
    }
    this.#committing = false;
    this.#commitRun = 0;
  }

  public parentFor(entry: MountedSceneElement): SVGGElement {
    const member = this.#membership.get(entry.id);
    if (member?.entry !== entry) return this.options.dom.group(entry.band);
    const run = member.run;
    const parent = firstPath(entry).parentNode;
    if (
      parent === run.prefix ||
      parent === run.suffix ||
      parent === this.options.dom.group("content") ||
      parent === this.options.dom.group("highlight")
    )
      return parent as SVGGElement;
    if (run.prefix !== undefined && entry.rank <= run.frontierRank) return run.prefix;
    return run.suffix ?? this.options.dom.group(entry.band);
  }

  public placement(
    entry: MountedSceneElement,
    successor: MountedSceneElement | undefined,
  ): {
    readonly parent: SVGGElement;
    readonly before: SVGElement | null;
  } {
    const parent = this.parentFor(entry);
    if (successor === undefined) return { parent, before: null };
    const successorMember = this.#membership.get(successor.id);
    const successorRun = successorMember?.entry === successor ? successorMember.run : undefined;
    if (!this.owns(entry) && successorRun !== undefined) {
      const boundary = successorRun.prefix ?? successorRun.suffix;
      return {
        parent,
        before: boundary?.parentNode === parent ? boundary : null,
      };
    }
    const root = firstPath(successor);
    return { parent, before: root.parentNode === parent ? root : null };
  }

  /** Stale preparation and finalized identity runs share the same cooperative drain. */
  public cleanup(
    deadline: number,
    now: () => number,
    onReleaseEntry: (entry: MountedSceneElement) => void,
  ): boolean {
    this.#cleaning = true;
    for (const run of this.#runs) {
      if (run.transform !== null) throw new Error("Clear the run transform before cleanup.");
      while (run.released < run.prepared) {
        if (now() >= deadline) return false;
        const entry = run.plan.entries[run.released]!;
        this.restoreOwnedRoots(entry, run);
        onReleaseEntry(entry);
        this.#membership.delete(entry.id);
        run.released += 1;
      }
      if (run.prefix !== undefined) this.options.paint?.(run.prefix, false);
      if (run.suffix !== undefined) this.options.paint?.(run.suffix, false);
      run.prefix?.remove();
      run.suffix?.remove();
      run.prefix = undefined;
      run.suffix = undefined;
    }
    this.#runs = [];
    this.#fragment = undefined;
    this.#committing = false;
    this.#cleaning = false;
    this.#commitRun = 0;
    return true;
  }

  /** Estimates: descriptor 128 B; borrowed entry reference 8 B; map/member slot 72 B;
   * retained UTF-16 transform characters 2 B. DOM and borrowed entry payloads excluded. */
  public memoryUsage(): number {
    let bytes = 128 + this.#membership.size * 72;
    for (const run of this.#runs)
      bytes += 128 + run.plan.entries.length * 8 + (run.transform?.length ?? 0) * 2;
    return bytes;
  }

  /** Renderer disposal already detached the scene; do not normalize its members. */
  public discard(): void {
    for (const run of this.#runs) {
      run.prefix?.remove();
      run.suffix?.remove();
    }
    this.#runs = [];
    this.#membership = new Map();
    this.#fragment = undefined;
    this.#committing = false;
    this.#cleaning = false;
    this.#commitRun = 0;
  }

  private prepareContainers(
    run: OwnedRun,
    deadline: number,
    now: () => number,
    publication: ScenePublicationBudget,
  ): boolean {
    const band = this.options.dom.group(run.plan.band);
    if (run.prefix === undefined) {
      if (now() >= deadline || publication.remainingRoots < 1) return false;
      run.prefix = this.createContainer(
        band,
        run.suffix ?? firstPath(run.plan.entries[0]!),
        publication,
      );
    }
    if (run.suffix === undefined) {
      if (now() >= deadline || publication.remainingRoots < 1) return false;
      run.suffix = this.createContainer(band, firstPath(run.plan.entries[0]!), publication);
    }
    return true;
  }

  private createContainer(
    band: SVGGElement,
    before: SVGElement,
    publication: ScenePublicationBudget,
  ): SVGGElement {
    const group = this.options.dom.ownerDocument.createElementNS(SVG_NAMESPACE, "g");
    band.insertBefore(group, before);
    publication.remainingRoots -= 1;
    this.options.instrumentation.domRootsPublished += 1;
    this.options.instrumentation.domFragmentRuns += 1;
    return group;
  }

  private move(entry: MountedSceneElement, parent: SVGGElement): void {
    this.#fragment ??= createFragment(this.options.dom.ownerDocument);
    appendElementToFragment(entry, this.#fragment);
    parent.append(this.#fragment);
    this.options.instrumentation.domReorders += 1;
    this.options.instrumentation.domFragmentRuns += 1;
  }

  private restoreOwnedRoots(entry: MountedSceneElement, run: OwnedRun): void {
    const band = this.options.dom.group(run.plan.band);
    const boundary = run.prefix ?? run.suffix;
    if (boundary === undefined) return;
    const restore = (node: SVGElement): void => {
      if (node.parentNode !== run.prefix && node.parentNode !== run.suffix) return;
      band.insertBefore(node, boundary);
      this.options.instrumentation.domFragmentRuns += 1;
    };
    if (entry.group !== null) restore(entry.group);
    else for (const path of entry.paths) restore(path.node);
  }
}
