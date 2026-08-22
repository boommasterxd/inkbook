import { VersionedCache } from "../cache/versioned-cache";
import {
  semanticAnchors,
  type AnchorTargetView,
  type ResolvedShapeAnchor,
} from "../geometry/anchors";

const DEFAULT_MAXIMUM_ENTRIES = 4_096;
const DEFAULT_MAXIMUM_BYTES = 8 * 1_024 * 1_024;
const ANCHOR_ENTRY_BYTES = 96;
const TARGET_ENTRY_OVERHEAD_BYTES = 64;

export interface SemanticAnchorCacheResult {
  readonly anchors: readonly ResolvedShapeAnchor[];
  readonly hit: boolean;
}

/** Geometry-versioned semantic anchors owned by the normalized element store. */
export class SemanticAnchorCache extends VersionedCache<readonly ResolvedShapeAnchor[]> {
  public constructor(
    maximumEntries = DEFAULT_MAXIMUM_ENTRIES,
    maximumBytes = DEFAULT_MAXIMUM_BYTES,
  ) {
    super(maximumEntries, maximumBytes);
  }

  public resolve(
    id: string,
    geometryVersion: number,
    target: AnchorTargetView,
  ): SemanticAnchorCacheResult {
    const cached = this.getCached(id, geometryVersion);
    if (cached !== undefined) return { anchors: cached, hit: true };

    const anchors = semanticAnchors(target);
    this.recordBuild();
    this.retainCached(
      id,
      geometryVersion,
      anchors,
      TARGET_ENTRY_OVERHEAD_BYTES + id.length * 2 + anchors.length * ANCHOR_ENTRY_BYTES,
    );
    return { anchors, hit: false };
  }
}
