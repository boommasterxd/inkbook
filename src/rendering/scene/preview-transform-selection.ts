import type { Bounds } from "../../domain/geometry/public";
import type { ArrowNodeV1, InkElementV1 } from "../../domain/schema/public";
import type { SceneCamera, SceneStorePort, SceneViewport } from "./types";

const MAX_PREVIEW_PATHS = 256;

interface Candidate {
  readonly distance: number;
  readonly id: string;
  readonly paths: number;
}

/** Owns selection membership for one preview lifetime, independently of camera updates. */
export class ViewportPreviewSelection {
  #source: readonly string[] | undefined;
  #members = new Set<string>();
  #retained: readonly string[] = [];
  #membershipBytes = 0;

  public select(
    ids: readonly string[],
    store: SceneStorePort,
    viewport: SceneViewport | undefined,
    camera: SceneCamera,
  ): readonly string[] {
    if (this.#source !== ids) {
      this.#source = ids;
      this.replaceMembership(ids);
    }
    const candidates = [new CandidateHeap(256), new CandidateHeap(128), new CandidateHeap(86)];
    const consider = (id: string): void => {
      if (!this.#members.has(id)) return;
      const record = store.get(id);
      if (record === undefined) return;
      const paths = elementPathCount(record.element);
      candidates[paths - 1]!.add({
        distance: distanceToViewport(record.bounds, viewport, camera),
        id,
        paths,
      });
    };
    if (ids.length <= MAX_PREVIEW_PATHS) {
      for (const id of ids) consider(id);
    } else if (viewport !== undefined) {
      const retained = new Set(this.#retained);
      for (const id of retained) consider(id);
      store.query(nearViewportBounds(viewport, camera), {
        add: (id) => {
          if (!retained.has(id)) consider(id);
        },
      });
    }
    this.#retained = selectPathBudget(candidates.flatMap((heap) => heap.values));
    return this.#retained;
  }

  public memoryUsage(): number {
    return this.#membershipBytes + this.#retained.length * 8;
  }

  private replaceMembership(ids: readonly string[]): void {
    this.#members.clear();
    this.#retained = [];
    this.#membershipBytes = ids.length * 8;
    for (const id of ids) {
      if (this.#members.has(id)) continue;
      this.#members.add(id);
      this.#membershipBytes += id.length * 2 + 32;
    }
  }

  public clear(): void {
    this.#source = undefined;
    this.#membershipBytes = 0;
    this.#members.clear();
    this.#retained = [];
  }
}

/** A maximum heap retains only the nearest candidates of one path cost. */
class CandidateHeap {
  public readonly values: Candidate[] = [];

  public constructor(private readonly capacity: number) {}

  public add(candidate: Candidate): void {
    if (this.values.length === this.capacity) {
      if (compare(candidate, this.values[0]!) >= 0) return;
      this.values[0] = candidate;
      this.sink();
      return;
    }
    let index = this.values.length;
    this.values.push(candidate);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compare(this.values[parent]!, candidate) >= 0) break;
      this.values[index] = this.values[parent]!;
      index = parent;
    }
    this.values[index] = candidate;
  }

  private sink(): void {
    let index = 0;
    const candidate = this.values[0]!;
    while (index * 2 + 1 < this.values.length) {
      let child = index * 2 + 1;
      const right = child + 1;
      if (right < this.values.length && compare(this.values[right]!, this.values[child]!) > 0) {
        child = right;
      }
      if (compare(candidate, this.values[child]!) >= 0) break;
      this.values[index] = this.values[child]!;
      index = child;
    }
    this.values[index] = candidate;
  }
}

function compare(left: Candidate, right: Candidate): number {
  return left.distance - right.distance || left.id.localeCompare(right.id);
}

function selectPathBudget(candidates: Candidate[]): readonly string[] {
  candidates.sort(compare);
  const selected: string[] = [];
  let paths = 0;
  for (const candidate of candidates) {
    if (paths + candidate.paths > MAX_PREVIEW_PATHS) continue;
    selected.push(candidate.id);
    paths += candidate.paths;
  }
  return selected;
}

function nearViewportBounds(viewport: SceneViewport, camera: SceneCamera): Bounds {
  return {
    minX: (viewport.left - viewport.width) / camera.zoom - camera.x,
    maxX: (viewport.left + viewport.width * 2) / camera.zoom - camera.x,
    minY: (viewport.top - viewport.height) / camera.zoom,
    maxY: (viewport.top + viewport.height * 2) / camera.zoom,
  };
}

function distanceToViewport(
  bounds: Bounds,
  viewport: SceneViewport | undefined,
  camera: SceneCamera,
): number {
  if (viewport === undefined) return 0;
  const centerX = ((bounds.minX + bounds.maxX) / 2 + camera.x) * camera.zoom;
  const centerY = ((bounds.minY + bounds.maxY) / 2) * camera.zoom;
  const viewportCenterX = viewport.left + viewport.width / 2;
  const viewportCenterY = viewport.top + viewport.height / 2;
  return Math.hypot(centerX - viewportCenterX, centerY - viewportCenterY);
}

function elementPathCount(element: InkElementV1): number {
  if (element.kind !== "arrow") return 1;
  return 1 + Number(isFilledNode(element.startNode)) + Number(isFilledNode(element.endNode));
}

function isFilledNode(node: ArrowNodeV1): boolean {
  return node === "triangle" || node === "diamond" || node === "circle";
}
