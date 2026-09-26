import { buildStrokePathParts } from "../../domain/geometry/stroke-path";
import type { StrokeElementV1 } from "../../domain/schema/public";

interface CachedCenter {
  readonly points: WeakRef<StrokeElementV1["points"]>;
  readonly rotation: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly path: string;
  readonly bytes: number;
}

/** Bounded derived strings survive culling without retaining document point buffers. */
export class SelectionCenterCache {
  readonly #entries = new Map<string, CachedCenter>();
  #bytes = 0;

  public memoryUsage(): number {
    return this.#bytes;
  }

  public read(element: StrokeElementV1): string | undefined {
    const cached = this.#entries.get(element.id);
    if (cached === undefined) return undefined;
    if (
      cached.points.deref() !== element.points ||
      cached.rotation !== element.rotation ||
      cached.x !== element.pivot.x ||
      cached.y !== element.pivot.y ||
      cached.width !== element.style.width
    ) {
      this.remove(element.id);
      return undefined;
    }
    this.#entries.delete(element.id);
    this.#entries.set(element.id, cached);
    return cached.path;
  }

  public build(element: StrokeElementV1): string {
    const path = buildStrokePathParts({
      ...element,
      style: { ...element.style, pressureEnabled: false },
    })
      .map(({ d }) => d)
      .join("");
    const bytes = 128 + (element.id.length + path.length) * 2;
    this.remove(element.id);
    if (bytes > 2 * 1024 * 1024) return path;
    while (this.#entries.size >= 4096 || this.#bytes + bytes > 2 * 1024 * 1024)
      this.remove(this.#entries.keys().next().value!);
    this.#entries.set(element.id, {
      points: new WeakRef(element.points),
      rotation: element.rotation,
      x: element.pivot.x,
      y: element.pivot.y,
      width: element.style.width,
      path,
      bytes,
    });
    this.#bytes += bytes;
    return path;
  }

  public clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  private remove(id: string): void {
    const cached = this.#entries.get(id);
    if (cached === undefined) return;
    this.#bytes -= cached.bytes;
    this.#entries.delete(id);
  }
}
