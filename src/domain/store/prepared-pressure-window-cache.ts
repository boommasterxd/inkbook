import { VersionedCache } from "../cache/versioned-cache";
import { measurePressureWindow, type PressureWindow } from "../geometry/pressure-window";
import type { PressureWindowMeasurement } from "../geometry/prepared-pressure-geometry";

const MAXIMUM_ENTRIES = 4096;
const MAXIMUM_BYTES = 8 * 1024 * 1024;
// Conservative allowance per cached alias for measurement and identity bookkeeping.
const MEASUREMENT_ENTRY_BYTES = 160;
interface WindowMeasurement extends PressureWindowMeasurement {
  readonly retainedBytes: number;
}
interface RetainedMeasurement {
  readonly measurement: WindowMeasurement;
  references: number;
}
interface CachedWindow {
  readonly strokeId: string;
  readonly measurement: WindowMeasurement;
}

/** One bounded LRU per store; the invalidation index contains retained keys only. */
export class PreparedPressureWindowCache extends VersionedCache<CachedWindow> {
  readonly #keys: Map<string, Set<string>>;
  readonly #maximumBytes: number;
  readonly #measurements: Map<PressureWindow, RetainedMeasurement>;

  public constructor(maximumEntries = MAXIMUM_ENTRIES, maximumBytes = MAXIMUM_BYTES) {
    const keys = new Map<string, Set<string>>();
    const measurements = new Map<PressureWindow, RetainedMeasurement>();
    super(maximumEntries, maximumBytes, (key, value) => {
      const strokeKeys = keys.get(value.strokeId);
      strokeKeys?.delete(key);
      if (strokeKeys?.size === 0) keys.delete(value.strokeId);
      const retained = measurements.get(value.measurement.window)!;
      retained.references -= 1;
      if (retained.references === 0) measurements.delete(value.measurement.window);
    });
    this.#keys = keys;
    this.#maximumBytes = maximumBytes;
    this.#measurements = measurements;
  }

  public get indexedStrokeCount(): number {
    return this.#keys.size;
  }

  public get measuredWindowCount(): number {
    return this.#measurements.size;
  }

  public read(id: string, version: number, index: number): PressureWindow | undefined {
    return this.readMeasurement(id, version, index)?.window;
  }

  public readMeasurement(
    id: string,
    version: number,
    index: number,
  ): PressureWindowMeasurement | undefined {
    assertWindowIndex(index);
    return this.getCached(`${id}:${String(index)}`, version)?.measurement;
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
    const measurement =
      this.#measurements.get(window)?.measurement ??
      Object.freeze(measurePressureWindow(window, true));
    const bytes = key.length * 2 + measurement.retainedBytes + MEASUREMENT_ENTRY_BYTES;
    if (bytes > this.#maximumBytes) return measurement;
    // An exact retained identity is the only reusable immutability witness.
    this.invalidateWindow(key);
    const keys = this.#keys.get(id) ?? new Set<string>();
    keys.add(key);
    this.#keys.set(id, keys);
    const retained = this.#measurements.get(window) ?? { measurement, references: 0 };
    retained.references += 1;
    this.#measurements.set(window, retained);
    this.recordBuild();
    this.retainCached(key, version, { strokeId: id, measurement }, bytes);
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

function assertWindowIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0)
    throw new RangeError("Invalid pressure window index.");
}
