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

const PATH_PART_OVERHEAD_BYTES = 48;
const SHARED_LOOKUP_OVERHEAD_BYTES = 128;

export interface PreparedScenePath {
  readonly geometry: readonly SvgPathPart[];
  readonly geometryMemoryBytes: number;
  readonly pressureWindows?: readonly PressureWindow[] | undefined;
}

interface CachedPath {
  readonly parts: readonly SvgPathPart[];
  readonly windows?: readonly PressureWindow[] | undefined;
  readonly pressureGeometry?: PreparedPressureGeometryPort | undefined;
  readonly releaseLookup?: () => void;
}

export class ScenePathCache extends VersionedCache<CachedPath> {
  readonly #identities = new WeakMap<object, Map<string, string>>();
  readonly #maximumBytes: number;
  #nextIdentity = 0;
  public constructor(maximumEntries = PATH_CACHE_MAX_ENTRIES, maximumBytes = PATH_CACHE_MAX_BYTES) {
    super(maximumEntries, maximumBytes, (_id, entry) => {
      entry.releaseLookup?.();
    });
    this.#maximumBytes = maximumBytes;
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
      this.retainShared(element.points, signature, parts, []);
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
    this.retainShared(points, signature, parts, windows);
    return parts;
  }

  private retainShared(
    points: object & { readonly length: number },
    signature: string,
    parts: readonly SvgPathPart[],
    windows: readonly PressureWindow[],
  ): void {
    if (!this.retentionEnabled) return;
    const bytes =
      SHARED_LOOKUP_OVERHEAD_BYTES +
      points.length * 8 +
      signature.length * 2 +
      pathBytes(parts) +
      windows.reduce((total, window) => total + pressureWindowRetainedBytes(window), 0);
    if (bytes > this.#maximumBytes) return;
    const lookup = this.#identities.get(points) ?? new Map<string, string>();
    const key = `\0stroke-geometry:${this.#nextIdentity++}`;
    this.retainCached(
      key,
      0,
      {
        parts,
        windows,
        releaseLookup: () => {
          lookup.delete(signature);
          if (lookup.size === 0) this.#identities.delete(points);
        },
      },
      bytes,
    );
    lookup.set(signature, key);
    this.#identities.set(points, lookup);
  }

  public cacheMemoryUsage(): number {
    return this.cachedBytes;
  }

  public take(id: string, geometryVersion: number): readonly SvgPathPart[] | undefined {
    const cached = this.takeCached(id, geometryVersion);
    if (cached === undefined) return undefined;
    if (cached.pressureGeometry !== undefined) {
      cached.windows?.forEach((window, index) =>
        cached.pressureGeometry!.publishWindow(index, window),
      );
    }
    return cached.parts;
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
    this.retainCached(
      id,
      geometryVersion,
      {
        // Preserve the lazy live-stroke handoff: taking the entry finalizes its geometry.
        get parts() {
          return prepared.geometry;
        },
        get windows() {
          return prepared.pressureWindows;
        },
        pressureGeometry,
      },
      id.length * 2 + prepared.geometryMemoryBytes,
    );
  }

  public retain(id: string, geometryVersion: number, parts: readonly SvgPathPart[]): void {
    const bytes = id.length * 2 + pathBytes(parts);
    this.retainCached(id, geometryVersion, { parts }, bytes);
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
