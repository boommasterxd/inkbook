import { VersionedCache } from "../cache/versioned-cache";
import { isStoredStroke } from "../elements/stroke-replacement-proof";
import { strokeLocalGeometry } from "../geometry/stroke-position";
import type { StrokeCenter } from "../geometry/stroke-path";
import type { StrokeElementV1 } from "../schema/public";

interface PreparedStrokeCenters {
  readonly samples: WeakRef<object>;
  readonly rotation: number;
  readonly pivotX: number;
  readonly pivotY: number;
  readonly width: number;
  readonly smoothing: number;
  readonly tool: StrokeElementV1["tool"];
  readonly pressureEnabled: boolean;
  readonly shapeVersion: number;
  readonly windows: Map<number, readonly StrokeCenter[]>;
  bytes: number;
}

/** One store-owned byte-bounded cache of demanded local simplification windows. */
export class PreparedStrokeCenterCache extends VersionedCache<PreparedStrokeCenters> {
  public constructor(maximumEntries = 4096, maximumBytes = 2 * 1024 * 1024) {
    super(maximumEntries, maximumBytes);
  }

  public resolve(id: string, version: number, stroke: StrokeElementV1): PreparedStrokeCenters {
    const local = strokeLocalGeometry(stroke);
    const cacheable = immutableSamples(stroke);
    const cached = cacheable ? this.getCached(id, 0) : undefined;
    if (
      cached?.samples.deref() === stroke.points &&
      cached.rotation === local.rotation &&
      cached.pivotX === local.pivot.x &&
      cached.pivotY === local.pivot.y &&
      cached.width === stroke.style.width &&
      cached.smoothing === stroke.style.smoothing &&
      cached.tool === stroke.tool &&
      cached.pressureEnabled === stroke.style.pressureEnabled
    )
      return cached;
    const entry: PreparedStrokeCenters = {
      samples: new WeakRef(stroke.points),
      rotation: local.rotation,
      pivotX: local.pivot.x,
      pivotY: local.pivot.y,
      width: stroke.style.width,
      smoothing: stroke.style.smoothing,
      tool: stroke.tool,
      pressureEnabled: stroke.style.pressureEnabled,
      shapeVersion: version,
      windows: new Map(),
      bytes: 192 + id.length * 2,
    };
    if (cacheable) this.retainCached(id, 0, entry, entry.bytes);
    return entry;
  }

  public read(
    id: string,
    version: number,
    stroke: StrokeElementV1,
    index: number,
  ): readonly StrokeCenter[] | undefined {
    return this.resolve(id, version, stroke).windows.get(index);
  }

  public publish(
    id: string,
    version: number,
    stroke: StrokeElementV1,
    index: number,
    centers: readonly StrokeCenter[],
  ): void {
    if (!this.retentionEnabled || !immutableSamples(stroke)) return;
    const entry = this.resolve(id, version, stroke);
    if (entry.windows.has(index)) return;
    const owned = Object.freeze(centers.map((center) => Object.freeze({ ...center })));
    entry.windows.set(index, owned);
    entry.bytes += 64 + owned.length * 64;
    this.recordBuild();
    this.retainCached(id, 0, entry, entry.bytes);
  }
}

function immutableSamples(stroke: StrokeElementV1): boolean {
  return Object.isFrozen(stroke.points) || isStoredStroke(stroke);
}

export function sameLocalSelectionShape(first: StrokeElementV1, second: StrokeElementV1): boolean {
  const a = strokeLocalGeometry(first);
  const b = strokeLocalGeometry(second);
  return (
    first.points === second.points &&
    first.rotation === second.rotation &&
    first.style.width === second.style.width &&
    first.style.smoothing === second.style.smoothing &&
    first.tool === second.tool &&
    first.style.pressureEnabled === second.style.pressureEnabled &&
    a.pivot.x === b.pivot.x &&
    a.pivot.y === b.pivot.y
  );
}
