import { roundCanonical } from "../../domain/geometry/primitives";
import { strokeLocalGeometry } from "../../domain/geometry/stroke-position";
import { localPressureGeometry } from "./stroke-position";
import { ProgressivePreviewPath } from "./progressive-preview-path";
import { isStoredStroke } from "../../domain/elements/stroke-replacement-proof";
import { pressureWindowRetainedBytes } from "../../domain/geometry/pressure-window";
import type { PressureWindow } from "../../domain/geometry/pressure-window";
import type { PreparedPressureGeometryPort } from "../../domain/geometry/prepared-pressure-geometry";
import type { SceneStorePort } from "./types";
import { VersionedCache } from "../../domain/cache/versioned-cache";
import { buildElementPathParts, type SvgPathPart } from "../../domain/geometry/element-path";
import type { InkElementV1 } from "../../domain/schema/public";
import { PATH_CACHE_MAX_BYTES, PATH_CACHE_MAX_ENTRIES } from "./constants";
import { SceneGeometryAliases } from "./scene-geometry-aliases";

const PATH_PART_OVERHEAD_BYTES = 48;
const SHARED_LOOKUP_OVERHEAD_BYTES = 128;

export interface PreparedScenePath {
  readonly geometry: readonly SvgPathPart[];
  readonly geometryMemoryBytes: number;
  readonly pressureWindows?: readonly PressureWindow[] | undefined;
}

interface CachedPath {
  readonly prepared?: boolean;
  readonly parts: readonly SvgPathPart[];
  readonly windows?: readonly PressureWindow[] | undefined;
  readonly pressureGeometry?: PreparedPressureGeometryPort | undefined;
  readonly releaseLookup?: () => void;
}

export class ScenePathCache extends VersionedCache<CachedPath> {
  readonly #identities = new WeakMap<object, Map<string, string>>();
  readonly #parts = new WeakMap<readonly SvgPathPart[], string>();
  readonly #retainedKeys = new Set<string>();
  readonly #aliases: SceneGeometryAliases;
  readonly #maximumBytes: number;
  readonly #maximumEntries: number;
  #nextIdentity = 0;
  public constructor(maximumEntries = PATH_CACHE_MAX_ENTRIES, maximumBytes = PATH_CACHE_MAX_BYTES) {
    const aliasBytes = Math.max(1, Math.min(Math.floor(maximumBytes / 4), maximumEntries * 256));
    super(maximumEntries, maximumBytes, (id, entry) => {
      this.#retainedKeys.delete(id);
      this.#aliases.invalidateKey(id);
      entry.releaseLookup?.();
    });
    this.#maximumBytes = maximumBytes;
    this.#maximumEntries = maximumEntries;
    this.#aliases = new SceneGeometryAliases(maximumEntries, aliasBytes);
  }

  public read(
    element: InkElementV1,
    pressureGeometry?: PreparedPressureGeometryPort,
  ): readonly SvgPathPart[] | undefined {
    pressureGeometry = localPressureGeometry(element, pressureGeometry);
    const prepared =
      element.kind === "stroke" && element.style.pressureEnabled
        ? pressureGeometry?.readPath?.()
        : undefined;
    if (prepared !== undefined) return prepared;
    const signature = immutableStrokeSignature(element);
    const points = element.kind === "stroke" ? element.points : undefined;
    const lookup = points === undefined ? undefined : this.#identities.get(points);
    const key = signature === undefined ? undefined : lookup?.get(signature);
    const cached = key === undefined ? undefined : this.getCached(key, 0);
    if (cached !== undefined) {
      this.#aliases.retain(element.id, undefined, key!);
      this.trimCachedToBytes(this.#maximumBytes - this.#aliases.memoryUsage());
      cached.windows?.forEach((window, index) => pressureGeometry?.publishWindow(index, window));
      return cached.parts;
    }
    return undefined;
  }

  public startPreparation(
    element: InkElementV1,
    pressureGeometry?: PreparedPressureGeometryPort,
  ): ProgressivePreviewPath {
    this.recordBuild();
    return new ProgressivePreviewPath(element, pressureGeometry);
  }

  public completePreparation(element: InkElementV1, parts: readonly SvgPathPart[]): void {
    const signature = immutableStrokeSignature(element);
    if (signature !== undefined && element.kind === "stroke")
      this.retainShared(element, signature, parts, []);
  }

  public build(
    element: InkElementV1,
    pressureGeometry?: PreparedPressureGeometryPort,
  ): readonly SvgPathPart[] {
    pressureGeometry = localPressureGeometry(element, pressureGeometry);
    const cached = this.read(element, pressureGeometry);
    if (cached !== undefined) return cached;
    const signature = immutableStrokeSignature(element);
    const points = element.kind === "stroke" ? element.points : undefined;
    this.recordBuild();
    element = element.kind === "stroke" ? strokeLocalGeometry(element) : element;
    if (signature === undefined || points === undefined || !this.retentionEnabled)
      return buildElementPathParts(element, pressureGeometry);
    const windows: PressureWindow[] = [];
    const parts = buildElementPathParts(element, {
      readWindow: (index) => {
        const window = pressureGeometry?.readWindow(index);
        if (window !== undefined) windows[index] = window;
        return window;
      },
      publishWindow: (index, window) => {
        windows[index] = window;
        pressureGeometry?.publishWindow(index, window);
      },
    });
    this.retainShared(element, signature, parts, windows);
    return parts;
  }

  private retainShared(
    element: InkElementV1,
    signature: string,
    parts: readonly SvgPathPart[],
    windows: readonly PressureWindow[],
  ): void {
    if (!this.retentionEnabled || element.kind !== "stroke") return;
    const points = element.points;
    const existingLookup = this.#identities.get(points);
    const existingKey = existingLookup?.get(signature);
    if (existingKey !== undefined && this.#retainedKeys.has(existingKey)) {
      this.#aliases.retain(element.id, undefined, existingKey);
      this.trimCachedToBytes(this.#maximumBytes - this.#aliases.memoryUsage());
      return;
    }
    const bytes =
      SHARED_LOOKUP_OVERHEAD_BYTES +
      points.length * 8 +
      signature.length * 2 +
      pathBytes(parts) +
      windows.reduce((total, window) => total + pressureWindowRetainedBytes(window), 0);
    if (bytes > this.#maximumBytes) return;
    const lookup = existingLookup ?? new Map<string, string>();
    const key = `\0stroke-geometry:${this.#nextIdentity++}`;
    this.retainCached(
      key,
      0,
      {
        parts,
        windows,
        releaseLookup: () => {
          if (lookup.get(signature) === key) lookup.delete(signature);
          if (lookup.size === 0) this.#identities.delete(points);
        },
      },
      bytes,
    );
    this.#retainedKeys.add(key);
    this.#parts.set(parts, key);
    lookup.set(signature, key);
    this.#identities.set(points, lookup);
    this.#aliases.retain(element.id, undefined, key);
    this.trimCachedToBytes(this.#maximumBytes - this.#aliases.memoryUsage());
  }

  public cacheMemoryUsage(): number {
    return this.cachedBytes + this.#aliases.memoryUsage();
  }

  /** Speculation uses spare capacity and never displaces required or recent contours. */
  public speculativeCapacityBytes(): number {
    const aliasReservation = 128 + (36 + `\0path:${this.#nextIdentity}`.length) * 2;
    if (
      !this.retentionEnabled ||
      this.statistics().entries >= this.#maximumEntries ||
      this.#aliases.availableBytes() < aliasReservation
    )
      return 0;
    return Math.max(0, this.#maximumBytes - this.cacheMemoryUsage() - aliasReservation);
  }

  public retainSpeculative(
    id: string,
    geometryVersion: number,
    parts: readonly SvgPathPart[],
  ): boolean {
    if (this.has(id, geometryVersion)) return true;
    const bytes = SHARED_LOOKUP_OVERHEAD_BYTES + id.length * 2 + pathBytes(parts);
    const aliasBytes = 128 + (id.length + `\0path:${this.#nextIdentity}`.length) * 2;
    if (bytes > this.speculativeCapacityBytes() || aliasBytes > this.#aliases.availableBytes())
      return false;
    this.retain(id, geometryVersion, parts);
    return this.has(id, geometryVersion);
  }

  public ownsPrepared(element: InkElementV1, parts: readonly SvgPathPart[]): boolean {
    const key = this.#parts.get(parts);
    const signature = immutableStrokeSignature(element);
    return (
      this.retentionEnabled &&
      element.kind === "stroke" &&
      signature !== undefined &&
      key !== undefined &&
      this.#retainedKeys.has(key) &&
      this.#identities.get(element.points)?.get(signature) === key
    );
  }

  public override statistics(): ReturnType<VersionedCache<CachedPath>["statistics"]> {
    return { ...super.statistics(), bytes: this.cacheMemoryUsage() };
  }

  public override release(): void {
    super.release();
    this.#aliases.release();
  }

  public override invalidate(id: string): void {
    const key = this.#aliases.invalidate(id);
    if (key !== undefined && !this.#aliases.hasOwners(key)) super.invalidate(key);
    super.invalidate(id);
  }

  public take(id: string, geometryVersion: number): readonly SvgPathPart[] | undefined {
    const key = this.#aliases.read(id, geometryVersion);
    const cached = key === undefined ? this.getCached(id, geometryVersion) : this.getCached(key, 0);
    if (cached === undefined) return undefined;
    // A lazy live handoff owns its builder until first use; release that owner immediately.
    if (cached.prepared === true && key !== undefined) this.takeCached(key, 0);
    if (cached.pressureGeometry !== undefined) {
      cached.windows?.forEach((window, index) =>
        cached.pressureGeometry!.publishWindow(index, window),
      );
    }
    const parts = cached.parts;
    this.#parts.set(parts, key ?? id);
    return parts;
  }

  public has(id: string, geometryVersion: number): boolean {
    const key = this.#aliases.read(id, geometryVersion);
    return key !== undefined && this.#retainedKeys.has(key);
  }

  public retainPreparedFromStore(
    id: string,
    prepared: PreparedScenePath,
    store: SceneStorePort,
  ): void {
    const record = store.get(id);
    if (record !== undefined)
      this.retainPrepared(
        id,
        record.geometryVersion,
        prepared,
        store.pressureGeometry?.(id, record.geometryVersion),
      );
  }

  public retainPrepared(
    id: string,
    geometryVersion: number,
    prepared: PreparedScenePath,
    pressureGeometry?: PreparedPressureGeometryPort,
  ): void {
    if (!this.retentionEnabled) return;
    const bytes = SHARED_LOOKUP_OVERHEAD_BYTES + id.length * 2 + prepared.geometryMemoryBytes;
    if (bytes > this.#maximumBytes) return;
    const key = `\0prepared:${this.#nextIdentity++}`;
    this.retainCached(
      key,
      0,
      {
        prepared: true,
        // Preserve the lazy live-stroke handoff: taking the entry finalizes its geometry.
        get parts() {
          return prepared.geometry;
        },
        get windows() {
          return prepared.pressureWindows;
        },
        pressureGeometry,
      },
      bytes,
    );
    this.#retainedKeys.add(key);
    this.#aliases.retain(id, geometryVersion, key);
    this.trimCachedToBytes(this.#maximumBytes - this.#aliases.memoryUsage());
  }

  public retain(id: string, geometryVersion: number, parts: readonly SvgPathPart[]): void {
    if (!this.retentionEnabled) return;
    const key = this.#parts.get(parts);
    if (key !== undefined && this.#retainedKeys.has(key)) {
      this.getCached(key, 0);
      this.#aliases.retain(id, geometryVersion, key);
      this.trimCachedToBytes(this.#maximumBytes - this.#aliases.memoryUsage());
      return;
    }
    const bytes = SHARED_LOOKUP_OVERHEAD_BYTES + id.length * 2 + pathBytes(parts);
    if (bytes > this.#maximumBytes) return;
    const canonical = `\0path:${this.#nextIdentity++}`;
    this.retainCached(canonical, 0, { parts }, bytes);
    this.#retainedKeys.add(canonical);
    this.#parts.set(parts, canonical);
    this.#aliases.retain(id, geometryVersion, canonical);
    this.trimCachedToBytes(this.#maximumBytes - this.#aliases.memoryUsage());
  }
}

function pathBytes(parts: readonly SvgPathPart[]): number {
  return parts.reduce((total, part) => total + part.d.length * 2 + PATH_PART_OVERHEAD_BYTES, 0);
}

function immutableStrokeSignature(element: InkElementV1): string | undefined {
  if (
    element.kind !== "stroke" ||
    !(
      Object.isFrozen(element.points) ||
      (element.points instanceof Float64Array && isStoredStroke(element))
    )
  )
    return undefined;
  return [
    element.tool,
    element.style.width,
    element.style.pressureEnabled,
    element.style.smoothing,
    element.rotation,
    roundCanonical(element.pivot.x - (element.offset?.x ?? 0)),
    roundCanonical(element.pivot.y - (element.offset?.y ?? 0)),
  ].join(":");
}
