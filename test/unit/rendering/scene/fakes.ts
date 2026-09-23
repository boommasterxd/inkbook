import { type SceneStorePort, type SpatialQuerySink } from "../../../../src/rendering/scene";
import {
  type SceneElementRecord,
  type SceneScheduler,
} from "../../../../src/rendering/scene/types";
import type { Bounds } from "../../../../src/domain/geometry/public";
import type { BoxShapeElementV1 } from "../../../../src/domain/schema/public";

class FakeStyle {
  [key: string]: unknown;

  public setProperty(property: string, value: string): void {
    this[property] = value;
  }

  public removeProperty(property: string): string {
    const previous = this[property];
    delete this[property];
    return typeof previous === "string" ? previous : "";
  }
}

export class FakeNode {
  public readonly attributes = new Map<string, string>();
  public readonly listeners = new Map<string, Set<EventListener>>();
  public readonly nodes: FakeNode[] = [];
  public parent: FakeNode | undefined;
  public readonly style = new FakeStyle();
  public tabIndex = -1;

  public constructor(
    public readonly ownerDocument: FakeDocument,
    public readonly tagName: string,
    public readonly fragment = false,
  ) {}

  public get children(): readonly FakeNode[] {
    return this.nodes;
  }

  public append(...nodes: FakeNode[]): void {
    for (const node of nodes) this.insertBefore(node, null);
  }

  public insertBefore(node: FakeNode, reference: FakeNode | null): FakeNode {
    const inserted = node.fragment ? [...node.nodes] : [node];
    if (node.fragment) node.nodes.length = 0;
    let target = reference === null ? this.nodes.length : this.nodes.indexOf(reference);
    if (target < 0) throw new Error("Reference node is not attached.");
    for (const child of inserted) {
      const previous = child.parent?.nodes.indexOf(child) ?? -1;
      if (previous >= 0) {
        child.parent?.nodes.splice(previous, 1);
        if (child.parent === this && previous < target) target -= 1;
      }
      child.parent = this;
      this.nodes.splice(target, 0, child);
      target += 1;
    }
    return node;
  }

  public remove(): void {
    const index = this.parent?.nodes.indexOf(this) ?? -1;
    if (index >= 0) this.parent?.nodes.splice(index, 1);
    this.parent = undefined;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  public addEventListener(name: string, listener: EventListener): void {
    const listeners = this.listeners.get(name) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  public removeEventListener(name: string, listener: EventListener): void {
    this.listeners.get(name)?.delete(listener);
  }
}

export class FakeDocument {
  public readonly body = new FakeNode(this, "body");
  public readonly defaultView = null;

  public createElementNS(_namespace: string, name: string): FakeNode {
    return new FakeNode(this, name);
  }

  public createDocumentFragment(): FakeNode {
    return new FakeNode(this, "#fragment", true);
  }
}

export function asDocument(document: FakeDocument): Document {
  return document as unknown as Document;
}

export function asElement(node: FakeNode): HTMLElement {
  return node as unknown as HTMLElement;
}

export function fakeNode(node: Element): FakeNode {
  return node as unknown as FakeNode;
}

export class FakeScheduler implements SceneScheduler {
  readonly #callbacks = new Map<number, FrameRequestCallback>();
  #handle = 0;
  public time = 0;

  public get pendingCount(): number {
    return this.#callbacks.size;
  }

  public cancelAnimationFrame(handle: number): void {
    this.#callbacks.delete(handle);
  }

  public now(): number {
    return this.time;
  }

  public requestAnimationFrame(callback: FrameRequestCallback): number {
    this.#handle += 1;
    this.#callbacks.set(this.#handle, callback);
    return this.#handle;
  }

  public runNext(): void {
    const next = this.#callbacks.entries().next().value;
    if (next === undefined) throw new Error("No frame is pending.");
    this.#callbacks.delete(next[0]);
    next[1](this.time);
  }

  public runFrame(): void {
    const handles = [...this.#callbacks.keys()];
    for (const handle of handles) {
      const callback = this.#callbacks.get(handle);
      if (callback === undefined) continue;
      this.#callbacks.delete(handle);
      callback(this.time);
    }
  }

  public runAll(limit = 100): void {
    let frames = 0;
    while (this.#callbacks.size > 0) {
      if (frames >= limit) throw new Error("Frame limit exceeded.");
      this.runNext();
      frames += 1;
    }
  }
}

export class FakeSceneStore implements SceneStorePort {
  public readonly records = new Map<string, SceneElementRecord>();
  public lastQuery: Bounds | undefined;

  public get(id: string): SceneElementRecord | undefined {
    return this.records.get(id);
  }

  public query(bounds: Bounds, sink: SpatialQuerySink): void {
    this.lastQuery = bounds;
    for (const record of this.records.values()) {
      if (
        record.bounds.maxX < bounds.minX ||
        record.bounds.minX > bounds.maxX ||
        record.bounds.maxY < bounds.minY ||
        record.bounds.minY > bounds.maxY
      ) {
        continue;
      }
      sink.add(record.id);
    }
  }
}

export function fakeRectangleRecord(
  id: string,
  rank: number,
  x: number,
  y = 10,
): SceneElementRecord {
  const element: BoxShapeElementV1 = {
    createdAt: rank,
    height: 20,
    id,
    kind: "rectangle",
    pivot: { x: x + 10, y: y + 10 },
    rotation: 0,
    style: {
      fillColor: null,
      fillOpacity: 1,
      outlineColor: { type: "rgba", value: "#112233FF" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
    width: 20,
    x,
    y,
  };
  return {
    band: "content",
    bounds: { maxX: x + 21, maxY: y + 21, minX: x - 1, minY: y - 1 },
    element,
    geometryVersion: 1,
    id,
    paintVersion: 1,
    rank,
  };
}

export function replaceWithRectangles(
  store: FakeSceneStore,
  prefix: string,
  count: number,
  yAt: (rank: number) => number,
): string[] {
  store.records.clear();
  const ids = new Array<string>(count);
  for (let rank = 0; rank < count; rank += 1) {
    const id = `${prefix}-${rank.toString().padStart(4, "0")}`;
    ids[rank] = id;
    store.records.set(id, fakeRectangleRecord(id, rank, yAt(rank)));
  }
  return ids;
}
