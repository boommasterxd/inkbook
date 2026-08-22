import { VersionedCache } from "../../domain/cache/versioned-cache";
import { buildElementPathParts, type SvgPathPart } from "../../domain/geometry/element-path";
import type { InkElementV1 } from "../../domain/schema/public";
import { PATH_CACHE_MAX_BYTES, PATH_CACHE_MAX_ENTRIES } from "./constants";

const PATH_PART_OVERHEAD_BYTES = 48;

export class ScenePathCache extends VersionedCache<readonly SvgPathPart[]> {
  public constructor(maximumEntries = PATH_CACHE_MAX_ENTRIES, maximumBytes = PATH_CACHE_MAX_BYTES) {
    super(maximumEntries, maximumBytes);
  }

  public build(element: InkElementV1): readonly SvgPathPart[] {
    this.recordBuild();
    return buildElementPathParts(element);
  }

  public cacheMemoryUsage(): number {
    return this.cachedBytes;
  }

  public take(id: string, geometryVersion: number): readonly SvgPathPart[] | undefined {
    return this.takeCached(id, geometryVersion);
  }

  public retain(id: string, geometryVersion: number, parts: readonly SvgPathPart[]): void {
    const bytes =
      id.length * 2 +
      parts.reduce((total, part) => total + part.d.length * 2 + PATH_PART_OVERHEAD_BYTES, 0);
    this.retainCached(id, geometryVersion, parts, bytes);
  }
}
