import type { Bounds } from "../../domain/geometry/primitives";
import { SVG_NAMESPACE } from "./constants";
import { autoPaintTransform, inverseAutoPaintTransform } from "./auto-paint-transform";
import { observeAutoPaintBounds, readAutoPaintBounds } from "./content/auto-paint-bounds";
import {
  bindAutoPaintInstrumentation,
  recordAutoPaintWrite,
  writeAutoPaintAttribute,
  createAutoPaintDefinitions,
  type AutoPaintDefinitions,
} from "./auto-paint-definitions";
import { AutoPaintAtom } from "./auto-paint-atom";
import { AutoPaintServers } from "./auto-paint-servers";
import { readyLivePaint } from "./content/live-paint-handoff";
import type { MutableSceneInstrumentation, SceneCamera, SceneViewport } from "./types";

const SCOPE = "data-inkbook-auto-scope";
const OVERSCAN_SCREEN_PX = 64;
const AUTO_CLASS = /(?:^|\s)inkbook-theme-(?:stroke|fill|stroke-fill)(?:\s|$)/;

interface Context {
  readonly defs: SVGDefsElement;
  readonly page: SVGPathElement;
  readonly images: SVGGElement;
  readonly root: SVGGElement;
  readonly observer: typeof MutationObserver | undefined;
  readonly hasImages: () => boolean | undefined;
  readonly invalidate: () => void;
  readonly instrumentation?: MutableSceneInstrumentation;
  readonly now?: () => number;
}
interface Scope {
  readonly root: SVGGElement;
  readonly node: SVGGElement;
  readonly source: SVGUseElement;
  readonly id: string;
  readonly clipped: Set<Entry>;
}
interface Entry {
  readonly node: SVGElement;
  readonly descendants: Set<Entry>;
  parent: Entry | undefined;
  atom: AutoPaintAtom | undefined;
  scope: Scope | undefined;
  owner: Scope | undefined;
  inverse: string;
}

/** Owns small per-paint raster regions and constant-work shared selection bases. */
export class SceneAutoPaint {
  #observer: MutationObserver | undefined;
  readonly #entries = new Map<SVGElement, Entry>();
  readonly #atoms = new Set<Entry>();
  readonly #queued = new Set<SVGElement>();
  readonly #dirtyEntries = new Set<Entry>();
  readonly #work: Generator<void>[] = [];
  readonly #preparations = new Map<SVGElement, Generator<void>>();
  readonly #prepared = new Map<SVGElement, Element | null>();
  readonly #records: MutationRecord[] = [];
  readonly #motionImages: SVGGElement;
  #recordIndex = 0;
  #definitions: AutoPaintDefinitions | undefined;
  #servers: AutoPaintServers | undefined;
  #enabled = false;
  #region = "";
  #bounds: Bounds | undefined;
  #nextId = 0;
  #imageLeases = 0;
  #preparing = false;
  #previousImageVisibility: string | null = null;
  #regionPending = false;
  #viewport: SceneViewport | undefined;
  #camera: SceneCamera = { x: 0, zoom: 1 };

  public constructor(private readonly context: Context) {
    if (context.instrumentation !== undefined)
      bindAutoPaintInstrumentation(context.defs, context.instrumentation);
    this.#motionImages = context.defs.ownerDocument.createElementNS(SVG_NAMESPACE, "g");
    this.#motionImages.style.setProperty("--inkbook-image-pixels-opacity", "0");
    recordAutoPaintWrite(context.defs);
    this.#motionImages.style.setProperty("--inkbook-image-substrate-opacity", "1");
    recordAutoPaintWrite(context.defs);
  }

  public flush(
    viewport: SceneViewport | undefined,
    camera: SceneCamera,
    deadline: number,
    now: () => number = this.context.now ?? (() => 0),
  ): boolean {
    this.#viewport = viewport;
    this.#camera = camera;
    this.collect(this.#observer?.takeRecords() ?? []);
    const enabled = this.hasImages();
    if (enabled !== this.#enabled) this.setEnabled(enabled);
    if (!enabled || viewport === undefined) return false;
    this.setRegion(viewport, camera);
    while (this.#recordIndex < this.#records.length && now() < deadline)
      this.record(this.#records[this.#recordIndex++]!);
    if (this.#recordIndex === this.#records.length) {
      this.#records.length = 0;
      this.#recordIndex = 0;
      this.#prepared.clear();
    }
    while (this.#work.length !== 0 && now() < deadline)
      if (this.#work[0]!.next().done) this.#work.shift();
    const pending =
      this.#records.length !== 0 || this.#work.length !== 0 || this.#preparations.size !== 0;
    if (!pending && this.#preparing) {
      this.#preparing = false;
      this.write(this.context.root, "data-inkbook-auto-enabled", "");
      this.write(this.context.images, "visibility", this.#previousImageVisibility);
    }
    return pending;
  }

  /** Live input owns immediate admission of its new bounded paint node. */
  public publishLive(node: SVGElement): void {
    if (!this.hasImages()) return;
    if (!this.#enabled) this.setEnabled(true);
    if (this.#viewport === undefined) return;
    this.setRegion(this.#viewport, this.#camera);
    this.refresh(node);
  }

  public readonly canPaint = (node: SVGElement): boolean =>
    !this.#enabled ||
    this.#preparing ||
    !AUTO_CLASS.test(node.getAttribute("class") ?? "") ||
    this.#entries.get(node)?.atom !== undefined;

  public ready(entry: Parameters<typeof readyLivePaint>[0]): boolean {
    return readyLivePaint(entry, this.canPaint, this.context.defs);
  }

  /** Run preparation owns these visits before its ready handoff. */
  public prepareRun(roots: readonly SVGElement[], deadline: number, now: () => number): boolean {
    if (!this.#enabled) return true;
    for (const root of roots) {
      if (this.#prepared.get(root) === root.parentElement) continue;
      if (root.parentElement !== null) this.refresh(root.parentElement as unknown as SVGElement);
      let steps = this.#preparations.get(root);
      if (steps === undefined) {
        steps = this.visitSubtree(root);
        this.#preparations.set(root, steps);
      }
      let complete = false;
      while (now() < deadline)
        if (steps.next().done) {
          complete = true;
          break;
        }
      if (!complete) return false;
      this.#preparations.delete(root);
      this.#prepared.set(root, root.parentElement);
    }
    return true;
  }

  public retainImage(node: SVGGElement): () => void {
    this.ensureDefinitions();
    const id = `${this.#definitions!.patternId}-image-${String(++this.#nextId)}`;
    this.write(node, "id", id);
    const use = this.context.defs.ownerDocument.createElementNS(SVG_NAMESPACE, "use");
    this.write(use, "href", `#${id}`);
    this.#motionImages.append(use);
    this.#imageLeases += 1;
    this.context.invalidate();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      use.remove();
      this.#imageLeases -= 1;
      this.context.invalidate();
    };
  }

  public release(): void {
    this.#observer?.disconnect();
    this.setEnabled(false);
    this.#definitions?.root.remove();
    this.#definitions = undefined;
    this.#servers = undefined;
  }

  public memoryUsage(): number {
    // Authored descriptors and retained DOM estimates; native filter textures remain browser-owned.
    return (
      this.#entries.size * 192 +
      this.#atoms.size * 256 +
      (this.#servers?.memoryUsage() ?? 0) +
      this.#records.length * 64 +
      this.#work.length * 48 +
      this.#preparations.size * 64
    );
  }

  private collect(records: readonly MutationRecord[]): void {
    if (this.#enabled) for (const record of records) this.#records.push(record);
  }

  private hasImages(): boolean {
    const stored = this.context.hasImages();
    return (
      stored === true ||
      this.#imageLeases !== 0 ||
      ((stored === undefined || this.#enabled) && this.context.images.hasChildNodes())
    );
  }

  private setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (enabled) {
      this.ensureDefinitions();
      // A newly published atom waits for its own bounded paint instead of allocating a viewport texture.
      this.#preparing = true;
      this.#previousImageVisibility = this.context.images.getAttribute("visibility");
      this.write(this.context.images, "visibility", "hidden");
      const observerConstructor = this.context.observer;
      if (this.#observer === undefined && observerConstructor !== undefined)
        this.#observer = new observerConstructor((records) => {
          this.collect(records);
          this.context.invalidate();
        });
      this.#observer?.observe(this.context.root, {
        attributes: true,
        attributeFilter: ["transform", "class", "data-inkbook-motion"],
        childList: true,
        subtree: true,
      });
      this.enqueue(this.context.root);
      return;
    }
    this.#observer?.disconnect();
    this.write(this.context.root, "data-inkbook-auto-enabled", null);
    if (this.#preparing)
      this.write(this.context.images, "visibility", this.#previousImageVisibility);
    this.#preparing = false;
    for (const entry of this.#entries.values()) this.remove(entry);
    for (const work of [...this.#work, ...this.#preparations.values()]) work.return(undefined);
    this.#work.length = 0;
    this.#records.length = 0;
    this.#recordIndex = 0;
    this.#queued.clear();
    this.#preparations.clear();
    this.#prepared.clear();
    this.#atoms.clear();
    this.#dirtyEntries.clear();
    this.#regionPending = false;
  }

  private ensureDefinitions(): void {
    this.#definitions ??= createAutoPaintDefinitions(
      this.context.defs,
      this.context.page,
      this.context.images,
      this.#motionImages,
    );
    this.#servers ??= new AutoPaintServers(this.#definitions);
  }

  private setRegion(viewport: SceneViewport, camera: SceneCamera): void {
    const reserve = OVERSCAN_SCREEN_PX / camera.zoom;
    this.#bounds = {
      minX: viewport.left / camera.zoom - camera.x - reserve,
      minY: viewport.top / camera.zoom - reserve,
      maxX: (viewport.left + viewport.width) / camera.zoom - camera.x + reserve,
      maxY: (viewport.top + viewport.height) / camera.zoom + reserve,
    };
    const key = Object.values(this.#bounds).join(" ");
    if (this.#region === key) return;
    this.#region = key;
    if (this.#atoms.size !== 0 && !this.#regionPending) {
      this.#regionPending = true;
      this.#work.push(this.refreshAtoms());
    }
  }

  private record(record: MutationRecord): void {
    if (record.type === "childList") {
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (node.nodeType !== 1) continue;
        const element = node as SVGElement;
        if (
          this.#entries.get(element)?.scope !== undefined &&
          this.context.root.contains(element)
        ) {
          this.refresh(element);
          continue;
        }
        if (
          this.#prepared.get(element) === element.parentElement &&
          this.context.root.contains(element)
        )
          continue;
        this.enqueue(element);
      }
    } else if (record.target !== this.context.root) {
      const node = record.target as SVGElement;
      const entry = this.#entries.get(node);
      if (entry?.scope !== undefined) this.writeScope(entry);
      else if (entry !== undefined && record.attributeName !== "class") this.enqueueEntry(entry);
      else this.enqueue(node);
    }
  }

  private enqueue(node: SVGElement): void {
    if (this.#queued.has(node)) return;
    this.#queued.add(node);
    this.#work.push(this.visitSubtree(node));
  }

  private *visitSubtree(root: SVGElement): Generator<void> {
    yield* this.visitNewNode(root);
    this.#queued.delete(root);
  }

  private *visitNewNode(node: SVGElement): Generator<void> {
    if (node === this.context.images || node.getAttribute("data-inkbook-image") !== null) return;
    this.refresh(node);
    yield;
    // eslint-disable-next-line no-restricted-syntax -- Only new subtrees are visited once; each actual descendant resumes through the shared deadline.
    for (const child of node.children)
      if (child.namespaceURI === SVG_NAMESPACE) yield* this.visitNewNode(child as SVGElement);
  }

  private *refreshTree(entry: Entry): Generator<void> {
    const pending = [entry];
    while (pending.length !== 0) {
      const current = pending.pop()!;
      const children = [...current.descendants];
      this.refresh(current.node);
      for (const child of children) pending.push(child);
      yield;
    }
    this.#dirtyEntries.delete(entry);
  }

  private enqueueEntry(entry: Entry): void {
    if (this.#dirtyEntries.has(entry)) return;
    this.#dirtyEntries.add(entry);
    this.#work.push(this.refreshTree(entry));
  }

  private *refreshAtoms(): Generator<void> {
    for (const entry of this.#atoms) {
      this.writeAtom(entry);
      yield;
    }
    this.#regionPending = false;
  }

  private refresh(node: SVGElement): void {
    if (node === this.context.root) return;
    let entry = this.#entries.get(node);
    const auto = AUTO_CLASS.test(node.getAttribute("class") ?? "");
    const isScope = node.getAttribute(SCOPE) !== null;
    const transform =
      node.getAttribute("transform") !== null || node.getAttribute("data-inkbook-motion") !== null;
    const tracksBounds = readAutoPaintBounds(node) !== undefined;
    if (!this.context.root.contains(node) || (!auto && !isScope && !transform && !tracksBounds)) {
      if (entry !== undefined) this.remove(entry);
      return;
    }
    if (entry === undefined) {
      entry = {
        node,
        descendants: new Set(),
        parent: undefined,
        atom: undefined,
        scope: undefined,
        owner: undefined,
        inverse: "",
      };
      this.#entries.set(node, entry);
      const target = entry;
      observeAutoPaintBounds(node, () => {
        this.enqueueEntry(target);
        this.context.invalidate();
      });
    }
    this.reparent(entry);
    if (isScope) this.writeScope(entry);
    else if (auto) this.writeAtom(entry);
    else this.removeAtom(entry);
  }

  private writeScope(entry: Entry): void {
    if (entry.scope === undefined) {
      const id = `${this.#definitions!.patternId}-scope-${String(++this.#nextId)}`;
      const root = this.context.defs.ownerDocument.createElementNS(SVG_NAMESPACE, "g");
      const source = this.context.defs.ownerDocument.createElementNS(SVG_NAMESPACE, "use");
      this.write(root, "id", id);
      this.write(source, "href", `#${this.#definitions!.underlayId}`);
      root.append(source);
      this.#definitions!.root.append(root);
      entry.scope = { root, node: entry.node as SVGGElement, source, id, clipped: new Set() };
    }
    const inverse = inverseAutoPaintTransform(autoPaintTransform(entry.node, this.context.root));
    if (inverse === undefined || entry.inverse === inverse) return;
    entry.inverse = inverse;
    this.write(entry.scope.source, "transform", inverse);
    this.#work.push(this.refreshClipped(entry.scope));
  }

  private *refreshClipped(scope: Scope): Generator<void> {
    for (const atom of scope.clipped) {
      this.writeAtom(atom);
      yield;
    }
  }

  private writeAtom(entry: Entry): void {
    if (!this.context.root.contains(entry.node) || this.#bounds === undefined) return;
    const owner = this.findScope(entry.node);
    if (entry.owner !== owner) {
      entry.owner?.clipped.delete(entry);
      entry.owner = owner;
    }
    if (entry.atom === undefined) {
      entry.atom = new AutoPaintAtom(entry.node, this.#definitions!, this.#servers!);
      this.#atoms.add(entry);
    }
    if (entry.atom.update(this.#bounds, this.context.root, this.#camera.zoom, owner))
      owner?.clipped.add(entry);
    else owner?.clipped.delete(entry);
  }

  private scopeNode(node: SVGElement): SVGGElement | undefined {
    for (
      let parent: Element | null = node.parentElement;
      parent !== null && parent !== this.context.root;
      parent = parent.parentElement
    )
      if (parent.getAttribute(SCOPE) !== null) return parent as SVGGElement;
    return undefined;
  }

  private findScope(node: SVGElement): Scope | undefined {
    const parent = this.scopeNode(node);
    return parent === undefined ? undefined : this.#entries.get(parent)?.scope;
  }

  private reparent(entry: Entry): void {
    let parent: Entry | undefined;
    for (
      let node: Element | null = entry.node.parentElement;
      node !== null && node !== this.context.root;
      node = node.parentElement
    ) {
      parent = this.#entries.get(node as SVGElement);
      if (parent !== undefined) break;
    }
    if (entry.parent === parent) return;
    entry.parent?.descendants.delete(entry);
    entry.parent = parent;
    parent?.descendants.add(entry);
  }

  private removeAtom(entry: Entry): void {
    if (entry.atom === undefined) return;
    entry.atom.release();
    entry.atom = undefined;
    entry.owner?.clipped.delete(entry);
    this.#atoms.delete(entry);
  }

  private remove(entry: Entry): void {
    observeAutoPaintBounds(entry.node);
    this.removeAtom(entry);
    entry.scope?.root.remove();
    entry.parent?.descendants.delete(entry);
    for (const child of entry.descendants) {
      child.parent = entry.parent;
      entry.parent?.descendants.add(child);
    }
    entry.descendants.clear();
    this.#entries.delete(entry.node);
  }

  private write(node: SVGElement, name: string, value: string | null): void {
    writeAutoPaintAttribute(this.context.defs, node, name, value);
  }
}
