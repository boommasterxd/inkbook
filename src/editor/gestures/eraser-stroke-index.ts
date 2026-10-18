import type { StrokeElementV1 } from "../../domain/schema/public";
import { isStoredStroke } from "../../domain/elements/stroke-replacement-proof";

const SEGMENTS_PER_SECTION = 32;
const MIN_INDEXED_POINTS = 64;
export const MAX_ERASER_INDEX_NODES = 131_072;
export const MAX_ERASER_INDEX_ENTRIES = 1_024;
export const MAX_ERASER_INDEX_BYTES = 8 * 1_024 * 1_024;

interface Segment {
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
}

/** Gesture-owned immutable geometry; no preparation reads or schedules work here. */
export class EraserStrokeIndexCache {
  readonly #entries = new Map<StrokeElementV1, EraserStrokeIndex | null>();
  #nodeCount = 0;
  #bytes = 0;

  public get nodeCount(): number {
    return this.#nodeCount;
  }

  public get byteLength(): number {
    return this.#bytes;
  }

  public acquire(element: StrokeElementV1): EraserStrokeIndex | null {
    const existing = this.#entries.get(element);
    if (existing === undefined) return null;
    this.#entries.delete(element);
    this.#entries.set(element, existing);
    if (existing !== null) return existing;
    const nodes = Math.ceil((element.points.length / 3 - 1) / SEGMENTS_PER_SECTION) * 2 - 1;
    const bytes = (nodes * 4 + ((nodes + 1) / 2) * 6) * Float64Array.BYTES_PER_ELEMENT;
    if (nodes > MAX_ERASER_INDEX_NODES || bytes > MAX_ERASER_INDEX_BYTES) return null;
    while (
      this.#nodeCount + nodes > MAX_ERASER_INDEX_NODES ||
      this.#bytes + bytes > MAX_ERASER_INDEX_BYTES
    ) {
      this.evictOldest();
    }
    const index = new EraserStrokeIndex(element.points.length / 3 - 1);
    this.#entries.set(element, index);
    this.#nodeCount += index.nodeCount;
    this.#bytes += index.byteLength;
    return index;
  }

  /** A first complete miss admits only its proven immutable identity, without buffers. */
  public rememberMiss(element: StrokeElementV1): void {
    if (element.points.length / 3 < MIN_INDEXED_POINTS || !isStoredStroke(element)) return;
    if (this.#entries.has(element)) return;
    if (this.#entries.size >= MAX_ERASER_INDEX_ENTRIES) this.evictOldest();
    this.#entries.set(element, null);
  }

  private evictOldest(): void {
    const oldest = this.#entries.keys().next().value!;
    const entry = this.#entries.get(oldest);
    this.#nodeCount -= entry?.nodeCount ?? 0;
    this.#bytes -= entry?.byteLength ?? 0;
    this.#entries.delete(oldest);
  }

  public clear(): void {
    this.#entries.clear();
    this.#nodeCount = 0;
    this.#bytes = 0;
  }
}

/** Leaves collect bounds on the second miss scan; each parent costs one later step. */
export class EraserStrokeIndex {
  readonly #bounds: Float64Array;
  readonly #oriented: Float64Array;
  readonly #leafStart: number;
  readonly #segmentCount: number;
  #parent: number;
  #scanned = false;
  readonly #projectedSweep = { startX: 0, startY: 0, endX: 0, endY: 0 };

  public constructor(segmentCount: number) {
    this.#segmentCount = segmentCount;
    const sections = Math.ceil(segmentCount / SEGMENTS_PER_SECTION);
    this.#leafStart = sections - 1;
    this.#bounds = new Float64Array((sections * 2 - 1) * 4);
    this.#oriented = new Float64Array(sections * 6);
    this.#parent = sections - 2;
  }

  public get nodeCount(): number {
    return this.#bounds.length / 4;
  }

  public get byteLength(): number {
    return this.#bounds.byteLength + this.#oriented.byteLength;
  }

  public get scanned(): boolean {
    return this.#scanned;
  }

  public get segmentCount(): number {
    return this.#segmentCount;
  }

  public record(segmentIndex: number, line: Segment): void {
    const node = this.#leafStart + Math.floor(segmentIndex / SEGMENTS_PER_SECTION);
    const offset = node * 4;
    const first = segmentIndex % SEGMENTS_PER_SECTION === 0;
    this.#bounds[offset] = Math.min(first ? line.startX : this.#bounds[offset]!, line.endX);
    this.#bounds[offset + 1] = Math.min(first ? line.startY : this.#bounds[offset + 1]!, line.endY);
    this.#bounds[offset + 2] = Math.max(first ? line.startX : this.#bounds[offset + 2]!, line.endX);
    this.#bounds[offset + 3] = Math.max(first ? line.startY : this.#bounds[offset + 3]!, line.endY);
    this.recordOriented(node - this.#leafStart, first, line);
    this.#scanned = segmentIndex === this.#segmentCount - 1;
  }

  private recordOriented(section: number, first: boolean, line: Segment): void {
    const offset = section * 6;
    if (first) {
      const dx = line.endX - line.startX;
      const dy = line.endY - line.startY;
      const length = Math.hypot(dx, dy);
      this.#oriented[offset + 4] = length === 0 ? 1 : dx / length;
      this.#oriented[offset + 5] = length === 0 ? 0 : dy / length;
      const x = this.#oriented[offset + 4]!;
      const y = this.#oriented[offset + 5]!;
      this.#oriented[offset] = this.#oriented[offset + 2] = line.startX * x + line.startY * y;
      this.#oriented[offset + 1] = this.#oriented[offset + 3] = line.startY * x - line.startX * y;
    }
    const x = this.#oriented[offset + 4]!;
    const y = this.#oriented[offset + 5]!;
    const endX = line.endX * x + line.endY * y;
    const endY = line.endY * x - line.endX * y;
    this.#oriented[offset] = Math.min(this.#oriented[offset]!, endX);
    this.#oriented[offset + 1] = Math.min(this.#oriented[offset + 1]!, endY);
    this.#oriented[offset + 2] = Math.max(this.#oriented[offset + 2]!, endX);
    this.#oriented[offset + 3] = Math.max(this.#oriented[offset + 3]!, endY);
  }

  /** A false result means one parent was prepared, without reading stroke samples. */
  public prepareOne(): boolean {
    if (this.#parent < 0) return true;
    const offset = this.#parent * 4;
    const left = (this.#parent * 2 + 1) * 4;
    const right = left + 4;
    this.#bounds[offset] = Math.min(this.#bounds[left]!, this.#bounds[right]!);
    this.#bounds[offset + 1] = Math.min(this.#bounds[left + 1]!, this.#bounds[right + 1]!);
    this.#bounds[offset + 2] = Math.max(this.#bounds[left + 2]!, this.#bounds[right + 2]!);
    this.#bounds[offset + 3] = Math.max(this.#bounds[left + 3]!, this.#bounds[right + 3]!);
    this.#parent -= 1;
    return false;
  }

  public overlaps(node: number, sweep: Segment, radius: number): boolean {
    if (!overlapsBounds(this.#bounds, node * 4, sweep, radius)) return false;
    if (node < this.#leafStart) return true;
    const offset = (node - this.#leafStart) * 6;
    const x = this.#oriented[offset + 4]!;
    const y = this.#oriented[offset + 5]!;
    const projected = this.#projectedSweep;
    projected.startX = sweep.startX * x + sweep.startY * y;
    projected.startY = sweep.startY * x - sweep.startX * y;
    projected.endX = sweep.endX * x + sweep.endY * y;
    projected.endY = sweep.endY * x - sweep.endX * y;
    return overlapsBounds(this.#oriented, offset, projected, radius);
  }

  public leafRange(node: number): number | null {
    if (node < this.#leafStart) return null;
    return (node - this.#leafStart) * SEGMENTS_PER_SECTION;
  }
}

function overlapsBounds(
  bounds: Float64Array,
  offset: number,
  sweep: Segment,
  radius: number,
): boolean {
  // Expand by accumulated dot-product/slab rounding error; rejection stays conservative.
  const guard =
    16 *
    Number.EPSILON *
    Math.max(
      1,
      Math.abs(sweep.startX),
      Math.abs(sweep.startY),
      Math.abs(sweep.endX),
      Math.abs(sweep.endY),
      Math.abs(bounds[offset]!),
      Math.abs(bounds[offset + 1]!),
      Math.abs(bounds[offset + 2]!),
      Math.abs(bounds[offset + 3]!),
      radius,
    );
  let from = 0;
  let to = 1;
  for (let axis = 0; axis < 2; axis += 1) {
    const start = axis === 0 ? sweep.startX : sweep.startY;
    const delta = (axis === 0 ? sweep.endX : sweep.endY) - start;
    const min = bounds[offset + axis]! - radius - guard;
    const max = bounds[offset + axis + 2]! + radius + guard;
    if (delta === 0) {
      if (start < min || start > max) return false;
    } else {
      const first = (min - start) / delta;
      const second = (max - start) / delta;
      from = Math.max(from, Math.min(first, second));
      to = Math.min(to, Math.max(first, second));
      if (from > to) return false;
    }
  }
  return true;
}

/** Each step builds or visits one node, or emits one exact segment for the caller. */
export class EraserStrokeIndexCursor {
  readonly #index: EraserStrokeIndex;
  readonly #pending = [0];
  #segment = 0;
  #end = 0;
  #prepared = false;

  public constructor(index: EraserStrokeIndex) {
    this.#index = index;
  }

  public get done(): boolean {
    return this.#pending.length === 0 && this.#segment >= this.#end;
  }

  public advance(sweep: Segment, radius: number): number | null {
    if (!this.#prepared) {
      if (!this.#index.prepareOne()) return null;
      this.#prepared = true;
    }
    if (this.#segment < this.#end) return this.#segment++;
    const node = this.#pending.pop();
    if (node === undefined || !this.#index.overlaps(node, sweep, radius)) return null;
    const range = this.#index.leafRange(node);
    if (range === null) this.#pending.push(node * 2 + 2, node * 2 + 1);
    else {
      this.#segment = range;
      this.#end = Math.min(range + SEGMENTS_PER_SECTION, this.#index.segmentCount);
    }
    return null;
  }
}
