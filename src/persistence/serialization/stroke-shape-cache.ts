import { buildElementPathParts, type SvgPathPart } from "../../domain/geometry/element-path";
import { strokeLocalGeometry } from "../../domain/geometry/stroke-position";
import type { StrokeElementV1 } from "../../domain/schema/public";

interface Entry {
  readonly stroke: StrokeElementV1;
  readonly parts: readonly SvgPathPart[];
  readonly bytes: number;
}

/** Session-owned local contours survive placement changes without retaining unbounded history. */
export class StrokeShapeCache {
  readonly #entries = new Map<string, Entry>();
  #bytes = 0;
  #builds = 0;
  public get instrumentation() {
    return {
      shapeBuilds: this.#builds,
      shapeCacheBytes: this.#bytes,
      shapeCacheElements: this.#entries.size,
    };
  }
  public resolve(stroke: StrokeElementV1): readonly SvgPathPart[] {
    const local = strokeLocalGeometry(stroke);
    const cached = this.#entries.get(stroke.id);
    if (cached !== undefined && sameShape(cached.stroke, local)) {
      this.#entries.delete(stroke.id);
      this.#entries.set(stroke.id, cached);
      return cached.parts;
    }
    const parts = buildElementPathParts(local);
    this.#builds += 1;
    const bytes =
      512 +
      stroke.id.length * 2 +
      parts.reduce((sum, part) => sum + 64 + part.d.length * 2, 0) +
      local.points.length * 8;
    this.remove(stroke.id);
    if (bytes > 32 * 1024 * 1024) return parts;
    this.#entries.set(stroke.id, { stroke: local, parts, bytes });
    this.#bytes += bytes;
    while (this.#bytes > 32 * 1024 * 1024 || this.#entries.size > 20_000) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    return parts;
  }
  public remove(id: string): void {
    const entry = this.#entries.get(id);
    if (entry !== undefined) this.#bytes -= entry.bytes;
    this.#entries.delete(id);
  }
  public ids(): IterableIterator<string> {
    return this.#entries.keys();
  }
  public clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
    this.#builds = 0;
  }
}

function sameShape(left: StrokeElementV1, right: StrokeElementV1): boolean {
  return (
    left.points === right.points &&
    left.rotation === right.rotation &&
    (left.rotation === 0 || (left.pivot.x === right.pivot.x && left.pivot.y === right.pivot.y)) &&
    left.tool === right.tool &&
    left.style.width === right.style.width &&
    left.style.pressureEnabled === right.style.pressureEnabled
  );
}
