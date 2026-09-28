import { VersionedCache } from "../cache/versioned-cache";
import { measurePressureWindow, type PressureWindow } from "../geometry/pressure-window";
import type { PressureWindowMeasurement } from "../geometry/prepared-pressure-geometry";

const MAXIMUM_ENTRIES = 4096;
const MAXIMUM_BYTES = 8 * 1024 * 1024;
interface CachedWindow {
  readonly strokeId: string;
  readonly window: PressureWindow;
}

/** One bounded LRU per store; the invalidation index contains retained keys only. */
export class PreparedPressureWindowCache extends VersionedCache<CachedWindow> {
  readonly #keys: Map<string, Set<string>>;
  readonly #maximumBytes: number;

  public constructor(maximumEntries = MAXIMUM_ENTRIES, maximumBytes = MAXIMUM_BYTES) {
    const keys = new Map<string, Set<string>>();
    super(maximumEntries, maximumBytes, (key, value) => {
      const strokeKeys = keys.get(value.strokeId);
      strokeKeys?.delete(key);
      if (strokeKeys?.size === 0) keys.delete(value.strokeId);
    });
    this.#keys = keys;
    this.#maximumBytes = maximumBytes;
  }

  public get indexedStrokeCount(): number {
    return this.#keys.size;
  }

  public read(id: string, version: number, index: number): PressureWindow | undefined {
    assertWindowIndex(index);
    return this.getCached(`${id}:${String(index)}`, version)?.window;
  }

  public publish(
    id: string,
    version: number,
    index: number,
    window: PressureWindow,
  ): PressureWindowMeasurement | undefined {
    assertWindowIndex(index);
    if (!this.retentionEnabled) return;
    const key = `${id}:${String(index)}`;
    const measurement = measurePressureWindow(window);
    const bytes = key.length * 2 + measurement.retainedBytes;
    if (bytes > this.#maximumBytes) return measurement;
    this.invalidateWindow(key);
    const keys = this.#keys.get(id) ?? new Set<string>();
    keys.add(key);
    this.#keys.set(id, keys);
    freezeWindow(window);
    this.recordBuild();
    this.retainCached(key, version, { strokeId: id, window }, bytes);
    return measurement;
  }

  public override invalidate(id: string): void {
    const keys = this.#keys.get(id);
    if (keys === undefined) return;
    for (const key of keys) this.invalidateWindow(key);
  }

  private invalidateWindow(key: string): void {
    super.invalidate(key);
  }
}

function freezeWindow(window: PressureWindow): void {
  for (const loop of window.loops) {
    for (const segment of loop) {
      Object.freeze(segment.start);
      Object.freeze(segment.end);
      if (segment.kind === "arc") Object.freeze(segment.center);
      Object.freeze(segment);
    }
    Object.freeze(loop);
  }
  for (const triangle of window.additions) {
    for (const point of triangle) Object.freeze(point);
    Object.freeze(triangle);
  }
  Object.freeze(window.additions);
  Object.freeze(window.loops);
  Object.freeze(window);
}

function assertWindowIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0)
    throw new RangeError("Invalid pressure window index.");
}
