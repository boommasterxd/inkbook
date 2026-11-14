import type { Bounds } from "../../../domain/geometry/primitives";
import type { TextElementV2, TextLayoutV2 } from "../../../domain/schema/types";

/** Retained paint regions cannot identify lines: they also merge backgrounds, grids and math. */
export class TextLineIndex {
  private constructor(
    public readonly layout: TextLayoutV2,
    private readonly tree: Float64Array,
    private readonly active: Uint8Array,
    private readonly leaf: number,
    public readonly count: number,
    public readonly nodeCount: number,
  ) {}

  public memoryUsage(): number {
    return this.tree.byteLength + this.active.byteLength + 64;
  }

  public static *prepare(element: TextElementV2): Generator<void, TextLineIndex> {
    let leaf = 1;
    while (leaf < element.layout.lines.length) leaf *= 2;
    const tree = new Float64Array(leaf * 8);
    const active = new Uint8Array(leaf * 2);
    let count = 0;
    let nodeCount = 0;
    for (let index = 0; index < element.layout.lines.length; index += 1) {
      const line = element.layout.lines[index]!;
      let left = line.x;
      let right = line.x + line.width;
      let padding = element.style.fontSize * 2;
      for (const run of line.runs) {
        left = Math.min(left, line.x + run.x);
        right = Math.max(right, line.x + run.x + run.width);
        padding = Math.max(padding, (run.style?.fontSize ?? element.style.fontSize) * 2);
        yield;
      }
      if (line.runs.length) {
        const node = leaf + index;
        const offset = node * 4;
        // Retained typographic boxes include a conservative overhang reserve, without DOM reads.
        tree[offset] = left - padding;
        tree[offset + 1] = line.y - padding;
        tree[offset + 2] = right + padding;
        tree[offset + 3] = line.y + line.height + padding;
        active[node] = 1;
        count += 1;
        nodeCount += line.runs.length + 1;
      }
      yield;
    }
    for (let node = leaf - 1; node > 0; node -= 1) {
      const left = node * 2;
      const right = left + 1;
      if (active[left] || active[right]) {
        active[node] = 1;
        const first = (active[left] ? left : right) * 4;
        const second = active[right] ? right * 4 : first;
        const offset = node * 4;
        tree[offset] = Math.min(tree[first]!, tree[second]!);
        tree[offset + 1] = Math.min(tree[first + 1]!, tree[second + 1]!);
        tree[offset + 2] = Math.max(tree[first + 2]!, tree[second + 2]!);
        tree[offset + 3] = Math.max(tree[first + 3]!, tree[second + 3]!);
      }
      yield;
    }
    return new TextLineIndex(element.layout, tree, active, leaf, count, nodeCount);
  }

  /** Array-order leaves preserve paint order even for nonmonotonic table-cell lines. */
  public *query(bounds: Bounds | undefined): Generator<number | undefined> {
    const pending = [1];
    while (pending.length) {
      const node = pending.pop()!;
      if (!this.active[node]) continue;
      const offset = node * 4;
      if (
        bounds === undefined ||
        (this.tree[offset]! <= bounds.maxX &&
          this.tree[offset + 2]! >= bounds.minX &&
          this.tree[offset + 1]! <= bounds.maxY &&
          this.tree[offset + 3]! >= bounds.minY)
      ) {
        if (node >= this.leaf) yield node - this.leaf;
        else pending.push(node * 2 + 1, node * 2);
      }
      yield undefined;
    }
  }
}
