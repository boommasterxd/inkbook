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
const SHARED_SIGNATURE_OVERHEAD_BYTES = 144;

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

interface PathIdentity {
  readonly key: string;
  readonly ownsParts: boolean;
}

interface SharedPathIdentity {
  readonly key: string;
  readonly signature: string;
  header?: WeakRef<InkElementV1> | undefined;
}

interface PathAccess {
  readonly id: string;
  readonly version: number | undefined;
  readonly key: string;
  readonly parts: readonly SvgPathPart[];
}

export class ScenePathCache extends VersionedCache<CachedPath> {
  readonly #identities = new WeakMap<object, Map<string, SharedPathIdentity>>();
  #signatures = new WeakMap<object, WeakRef<SharedPathIdentity>>();
  readonly #parts = new WeakMap<readonly SvgPathPart[], PathIdentity>();
  readonly #retainedKeys = new Map<string, boolean>();
  readonly #aliases: SceneGeometryAliases;
  readonly #maximumBytes: number;
  readonly #maximumEntries: number;
  #nextIdentity = 0;
  #generation = 0;
  // Only the immediately preceding contour access can suppress a second LRU promotion.
  #lastAccess: PathAccess | undefined;
  public constructor(maximumEntries = PATH_CACHE_MAX_ENTRIES, maximumBytes = PATH_CACHE_MAX_BYTES) {
    const aliasBytes = Math.max(1, Math.min(Math.floor(maximumBytes / 4), maximumEntries * 256));
    super(maximumEntries, maximumBytes, (id, entry) => {
      this.#retainedKeys.delete(id);
      if (this.#lastAccess?.key === id) this.#lastAccess = undefined;
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
    geometryVersion?: number,
  ): readonly SvgPathPart[] | undefined {
    this.#lastAccess = undefined;
    pressureGeometry = localPressureGeometry(element, pressureGeometry);
    const prepared =
      element.kind === "stroke" && element.style.pressureEnabled
        ? pressureGeometry?.readPath?.()
        : undefined;
    if (prepared !== undefined) return prepared;
    const signature = this.strokeSignature(element);
    const points = element.kind === "stroke" ? element.points : undefined;
    const lookup = points === undefined ? undefined : this.#identities.get(points);
    const identity = signature === undefined ? undefined : lookup?.get(signature);
    const key = identity?.key;
    const cached = key === undefined ? undefined : this.getCached(key, 0);
    if (cached !== undefined) {
      this.memoizeSignature(element, identity!);
      this.#aliases.retain(element.id, geometryVersion, key!);
      this.trimCachedToBytes(this.#maximumBytes - this.#aliases.memoryUsage());
      cached.windows?.forEach((window, index) => pressureGeometry?.publishWindow(index, window));
      if (this.#retainedKeys.has(key!))
        this.#lastAccess = {
          id: element.id,
          version: geometryVersion,
          key: key!,
          parts: cached.parts,
        };
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

  public completePreparation(
    element: InkElementV1,
    parts: readonly SvgPathPart[],
    geometryVersion?: number,
  ): void {
    const signature = this.strokeSignature(element);
    if (signature !== undefined && element.kind === "stroke")
      this.retainShared(element, signature, parts, [], geometryVersion);
  }

  public build(
    element: InkElementV1,
    pressureGeometry?: PreparedPressureGeometryPort,
  ): readonly SvgPathPart[] {
    pressureGeometry = localPressureGeometry(element, pressureGeometry);
    const cached = this.read(element, pressureGeometry);
    if (cached !== undefined) return cached;
    const signature = this.strokeSignature(element);
    const points = element.kind === "stroke" ? element.points : undefined;
    const generation = this.#generation;
    this.recordBuild();
    const local = element.kind === "stroke" ? strokeLocalGeometry(element) : element;
    if (signature === undefined || points === undefined || !this.retentionEnabled)
      return buildElementPathParts(local, pressureGeometry);
    const windows: PressureWindow[] = [];
    const parts = buildElementPathParts(local, {
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
    if (generation === this.#generation) this.retainShared(element, signature, parts, windows);
    return parts;
  }

  private retainShared(
    element: InkElementV1,
    signature: string,
    parts: readonly SvgPathPart[],
    windows: readonly PressureWindow[],
    geometryVersion?: number,
  ): void {
    this.#lastAccess = undefined;
    if (!this.retentionEnabled || element.kind !== "stroke") return;
    const points = element.points;
    const existingLookup = this.#identities.get(points);
    const existingIdentity = existingLookup?.get(signature);
    const existingKey = existingIdentity?.key;
    if (existingKey !== undefined && this.#retainedKeys.has(existingKey)) {
      this.memoizeSignature(element, existingIdentity!);
      if (this.#parts.get(parts)?.key !== existingKey)
        this.#parts.set(parts, { key: existingKey, ownsParts: false });
      this.#aliases.retain(element.id, geometryVersion, existingKey);
      this.trimCachedToBytes(this.#maximumBytes - this.#aliases.memoryUsage());
      return;
    }
    const bytes = sharedPathBytes(points, signature, parts, windows);
    if (bytes > this.#maximumBytes) return;
    const lookup = existingLookup ?? new Map<string, SharedPathIdentity>();
    const key = `\0stroke-geometry:${this.#nextIdentity++}`;
    const identity: SharedPathIdentity = { key, signature };
    this.retainCached(
      key,
      0,
      {
        parts,
        windows,
        releaseLookup: () => {
          this.releaseSignature(identity);
          if (lookup.get(signature)?.key === key) lookup.delete(signature);
          if (lookup.size === 0) this.#identities.delete(points);
        },
      },
      bytes,
    );
    this.#retainedKeys.set(key, true);
    this.#parts.set(parts, { key, ownsParts: true });
    lookup.set(signature, identity);
    this.#identities.set(points, lookup);
    this.memoizeSignature(element, identity);
    this.#aliases.retain(element.id, geometryVersion, key);
    this.trimCachedToBytes(this.#maximumBytes - this.#aliases.memoryUsage());
    if (this.#retainedKeys.has(key))
      this.#lastAccess = { id: element.id, version: geometryVersion, key, parts };
  }

  private strokeSignature(element: InkElementV1): string | undefined {
    const identity = this.#signatures.get(element)?.deref();
    return identity !== undefined && this.#retainedKeys.has(identity.key)
      ? identity.signature
      : immutableStrokeSignature(element);
  }

  private memoizeSignature(element: InkElementV1, identity: SharedPathIdentity): void {
    // Public frozen samples can still have mutable headers. Never memoize those values.
    if (
      this.#signatures.get(element)?.deref() !== identity &&
      isStoredStroke(element) &&
      Object.isFrozen(element) &&
      Object.isFrozen(element.style) &&
      Object.isFrozen(element.pivot) &&
      (element.kind !== "stroke" || element.offset === undefined || Object.isFrozen(element.offset))
    ) {
      // One weak header owner per retained contour bounds memo cells by the entry cap.
      this.releaseSignature(identity);
      identity.header = new WeakRef(element);
      this.#signatures.set(element, new WeakRef(identity));
    }
  }

  private releaseSignature(identity: SharedPathIdentity): void {
    const header = identity.header?.deref();
    if (header !== undefined && this.#signatures.get(header)?.deref() === identity)
      this.#signatures.delete(header);
    identity.header = undefined;
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
    element?: InkElementV1,
  ): boolean {
    if (this.has(id, geometryVersion)) return true;
    const signature = element === undefined ? undefined : this.strokeSignature(element);
    const shared = signature !== undefined && element?.kind === "stroke";
    const existingKey = shared
      ? this.#identities.get(element.points)?.get(signature)?.key
      : undefined;
    const retained = existingKey !== undefined && this.#retainedKeys.has(existingKey);
    const key = retained
      ? existingKey
      : `\0${shared ? "stroke-geometry" : "path"}:${this.#nextIdentity}`;
    const bytes = retained
      ? 0
      : shared
        ? sharedPathBytes(element.points, signature, parts, [])
        : SHARED_LOOKUP_OVERHEAD_BYTES + id.length * 2 + pathBytes(parts);
    const aliasBytes = 128 + (id.length + key.length) * 2;
    if (bytes > this.speculativeCapacityBytes() || aliasBytes > this.#aliases.availableBytes())
      return false;
    if (bytes + aliasBytes > this.#maximumBytes - this.cacheMemoryUsage()) return false;
    if (shared) this.completePreparation(element, parts);
    this.retain(id, geometryVersion, parts);
    return this.has(id, geometryVersion);
  }

  public ownsPrepared(element: InkElementV1, parts: readonly SvgPathPart[]): boolean {
    const identity = this.#parts.get(parts);
    const key = identity?.key;
    const signature = this.strokeSignature(element);
    return (
      this.retentionEnabled &&
      element.kind === "stroke" &&
      signature !== undefined &&
      identity?.ownsParts === true &&
      key !== undefined &&
      this.#retainedKeys.has(key) &&
      this.#identities.get(element.points)?.get(signature)?.key === key
    );
  }

  public override statistics(): ReturnType<VersionedCache<CachedPath>["statistics"]> {
    return { ...super.statistics(), bytes: this.cacheMemoryUsage() };
  }

  public override release(): void {
    this.#lastAccess = undefined;
    this.#generation += 1;
    super.release();
    this.#signatures = new WeakMap();
    this.#aliases.release();
  }

  public override invalidate(id: string): void {
    this.#lastAccess = undefined;
    const key = this.#aliases.invalidate(id);
    // Retire immutable shapes in the same bounded LRU; deleted IDs lose access immediately.
    if (key !== undefined && !this.#retainedKeys.get(key) && !this.#aliases.hasOwners(key))
      super.invalidate(key);
    super.invalidate(id);
  }

  public take(id: string, geometryVersion: number): readonly SvgPathPart[] | undefined {
    this.#lastAccess = undefined;
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
    this.#parts.set(parts, { key: key ?? id, ownsParts: true });
    if (key !== undefined && this.#retainedKeys.has(key))
      this.#lastAccess = { id, version: geometryVersion, key, parts };
    return parts;
  }

  public has(id: string, geometryVersion: number): boolean {
    const key = this.#aliases.peek(id, geometryVersion);
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
    this.#lastAccess = undefined;
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
    this.#retainedKeys.set(key, false);
    this.#aliases.retain(id, geometryVersion, key);
    this.trimCachedToBytes(this.#maximumBytes - this.#aliases.memoryUsage());
  }

  public retain(id: string, geometryVersion: number, parts: readonly SvgPathPart[]): void {
    if (!this.retentionEnabled) return;
    const key = this.#parts.get(parts)?.key;
    if (key !== undefined && this.#retainedKeys.has(key)) {
      const accessed = this.#lastAccess?.key === key && this.#lastAccess.parts === parts;
      const aliasAccessed =
        accessed && this.#lastAccess?.id === id && this.#lastAccess.version === geometryVersion;
      this.#lastAccess = undefined;
      if (!accessed) this.getCached(key, 0);
      if (!aliasAccessed || this.#aliases.peek(id, geometryVersion) !== key)
        this.#aliases.retain(id, geometryVersion, key);
      this.trimCachedToBytes(this.#maximumBytes - this.#aliases.memoryUsage());
      return;
    }
    this.#lastAccess = undefined;
    const bytes = SHARED_LOOKUP_OVERHEAD_BYTES + id.length * 2 + pathBytes(parts);
    if (bytes > this.#maximumBytes) return;
    const canonical = `\0path:${this.#nextIdentity++}`;
    this.retainCached(canonical, 0, { parts }, bytes);
    this.#retainedKeys.set(canonical, false);
    this.#parts.set(parts, { key: canonical, ownsParts: true });
    this.#aliases.retain(id, geometryVersion, canonical);
    this.trimCachedToBytes(this.#maximumBytes - this.#aliases.memoryUsage());
  }
}

function pathBytes(parts: readonly SvgPathPart[]): number {
  return parts.reduce((total, part) => total + part.d.length * 2 + PATH_PART_OVERHEAD_BYTES, 0);
}

function sharedPathBytes(
  points: { readonly length: number },
  signature: string,
  parts: readonly SvgPathPart[],
  windows: readonly PressureWindow[],
): number {
  return (
    SHARED_LOOKUP_OVERHEAD_BYTES +
    SHARED_SIGNATURE_OVERHEAD_BYTES +
    points.length * 8 +
    signature.length * 2 +
    pathBytes(parts) +
    windows.reduce((total, window) => total + pressureWindowRetainedBytes(window), 0)
  );
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
