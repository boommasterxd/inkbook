import type { TextElementV2 } from "../schema/public";
import type { Bounds } from "./primitives";
import { textPaintRegionSteps, type TextPaintRegion } from "./text-paint-regions";

export type { TextPaintRegion } from "./text-paint-regions";

/** Immutable field-local paint with one bounded binary bounds tree, owned by its record. */
export class TextPaintGeometry {
  public constructor(
    public readonly regions: readonly TextPaintRegion[],
    private readonly bounds: Float64Array,
    private readonly active: Uint8Array,
    private readonly leafBase: number,
  ) {}

  public memoryUsage(): number {
    // Region objects are accounted conservatively; shared clips are included in this allowance.
    return this.bounds.byteLength + this.active.byteLength + this.regions.length * 96 + 64;
  }

  /** A false visitor result stops the query without inspecting unrelated regions. */
  public query(
    bounds: Bounds,
    visitor: (region: TextPaintRegion) => boolean,
    visit?: () => void,
  ): boolean {
    if (!validBounds(bounds)) return true;
    const pending = [1];
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (!this.active[node]) continue;
      visit?.();
      if (!nodeIntersects(this.bounds, node, bounds)) continue;
      if (node >= this.leafBase) {
        if (!visitor(this.regions[node - this.leafBase]!)) return false;
      } else pending.push(node * 2 + 1, node * 2);
    }
    return true;
  }

  /** Cooperative area/sweep queries yield at every observed bounds-node inspection. */
  public *querySteps(bounds?: Bounds, visit?: () => void): Generator<TextPaintRegion | void> {
    if (bounds === undefined) {
      for (const region of this.regions) {
        visit?.();
        yield region;
      }
      return;
    }
    if (!validBounds(bounds)) return;
    const pending = [1];
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (!this.active[node]) continue;
      visit?.();
      if (nodeIntersects(this.bounds, node, bounds)) {
        if (node >= this.leafBase) yield this.regions[node - this.leafBase]!;
        else pending.push(node * 2 + 1, node * 2);
      }
      yield;
    }
  }
}

/** Preparation finishes before publication; queries never parse text or build indexes. */
export function* prepareTextPaintGeometrySteps(
  element: TextElementV2,
  visit?: () => void,
): Generator<void, TextPaintGeometry> {
  const regions = yield* sortRegions(yield* textPaintRegionSteps(element, visit), visit);
  let leafBase = 1;
  while (leafBase < regions.length) leafBase *= 2;
  const bounds = new Float64Array(leafBase * 8);
  const active = new Uint8Array(leafBase * 2);
  for (let index = 0; index < regions.length; index += 1) {
    const rectangle = regions[index]!;
    const node = leafBase + index;
    const offset = node * 4;
    bounds[offset] = rectangle.x;
    bounds[offset + 1] = rectangle.y;
    bounds[offset + 2] = rectangle.x + rectangle.width;
    bounds[offset + 3] = rectangle.y + rectangle.height;
    active[node] = 1;
    visit?.();
    yield;
  }
  for (let node = leafBase - 1; node > 0; node -= 1) {
    mergeChildren(bounds, active, node);
    visit?.();
    yield;
  }
  return new TextPaintGeometry(regions, bounds, active, leafBase);
}

function* sortRegions(
  regions: TextPaintRegion[],
  visit: (() => void) | undefined,
): Generator<void, TextPaintRegion[]> {
  let input = regions;
  let output = new Array<TextPaintRegion>(regions.length);
  for (let width = 1; width < regions.length; width *= 2) {
    for (let start = 0; start < regions.length; start += width * 2) {
      const middle = Math.min(start + width, regions.length);
      const end = Math.min(start + width * 2, regions.length);
      let left = start;
      let right = middle;
      for (let index = start; index < end; index += 1) {
        const takeLeft =
          right >= end || (left < middle && compareRegions(input[left]!, input[right]!) <= 0);
        output[index] = input[takeLeft ? left++ : right++]!;
        visit?.();
        yield;
      }
    }
    [input, output] = [output, input];
  }
  return input;
}

function compareRegions(left: TextPaintRegion, right: TextPaintRegion): number {
  return left.y - right.y || left.x - right.x;
}

function mergeChildren(bounds: Float64Array, active: Uint8Array, node: number): void {
  const left = node * 2;
  const right = left + 1;
  if (!active[left] && !active[right]) return;
  active[node] = 1;
  const first = active[left] ? left * 4 : right * 4;
  const second = active[right] ? right * 4 : first;
  const offset = node * 4;
  bounds[offset] = Math.min(bounds[first]!, bounds[second]!);
  bounds[offset + 1] = Math.min(bounds[first + 1]!, bounds[second + 1]!);
  bounds[offset + 2] = Math.max(bounds[first + 2]!, bounds[second + 2]!);
  bounds[offset + 3] = Math.max(bounds[first + 3]!, bounds[second + 3]!);
}

function nodeIntersects(tree: Float64Array, node: number, bounds: Bounds): boolean {
  const offset = node * 4;
  return (
    tree[offset]! <= bounds.maxX &&
    tree[offset + 2]! >= bounds.minX &&
    tree[offset + 1]! <= bounds.maxY &&
    tree[offset + 3]! >= bounds.minY
  );
}

function validBounds(bounds: Bounds): boolean {
  return (
    Number.isFinite(bounds.minX) &&
    Number.isFinite(bounds.maxX) &&
    Number.isFinite(bounds.minY) &&
    Number.isFinite(bounds.maxY) &&
    bounds.minX <= bounds.maxX &&
    bounds.minY <= bounds.maxY
  );
}
