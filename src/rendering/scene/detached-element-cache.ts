import { VersionedCache } from "../../domain/cache/versioned-cache";
import type { MutableSceneInstrumentation, SceneElementRecord } from "./types";
import {
  setMountedElementFade,
  setMountedElementMotion,
  updateMountedPaint,
  updatePreviewTransform,
  type MountedSceneElement,
} from "./mounted-element";
import { DETACHED_ELEMENT_CACHE_MAX_BYTES, DETACHED_ELEMENT_CACHE_MAX_ENTRIES } from "./constants";

/** Retains complete detached scene nodes; publication still uses the shared root cap. */
export class DetachedSceneElementCache extends VersionedCache<MountedSceneElement> {
  public constructor(
    maximumEntries = DETACHED_ELEMENT_CACHE_MAX_ENTRIES,
    maximumBytes = DETACHED_ELEMENT_CACHE_MAX_BYTES,
  ) {
    super(maximumEntries, maximumBytes);
  }

  public retain(entry: MountedSceneElement): void {
    // Previews are transient geometry; they must never become a committed revisit.
    if (entry.displayedPathParts !== entry.pathParts) return;
    const bytes = detachedElementBytes(entry);
    this.retainCached(entry.id, entry.geometryVersion, entry, bytes);
  }

  public take(
    record: SceneElementRecord,
    instrumentation: MutableSceneInstrumentation,
  ): MountedSceneElement | undefined {
    const entry = this.takeCached(record.id, record.geometryVersion);
    if (entry === undefined) return undefined;
    if (entry.fadeActive) setMountedElementFade(entry, null);
    setMountedElementMotion(entry, null);
    if (entry.paintVersion !== record.paintVersion)
      updateMountedPaint(entry, record, entry.pathParts, instrumentation);
    entry.displayedElement = record.element;
    entry.band = record.band;
    entry.rank = record.rank;
    entry.committedOrderEpoch = 0;
    entry.detachedPathCount = 0;
    updatePreviewTransform(entry, null, 0, null, instrumentation);
    return entry;
  }

  public memoryUsage(): number {
    return this.cachedBytes;
  }
}

/** Conservative owned-storage estimate; browser allocator overhead is implementation-specific. */
function detachedElementBytes(entry: MountedSceneElement): number {
  const elementBytes =
    entry.displayedElement.kind === "stroke" ? entry.displayedElement.points.length * 8 : 256;
  return (
    512 +
    entry.id.length * 2 +
    elementBytes +
    (entry.group === null ? 0 : 512) +
    entry.paths.reduce((total, path) => total + 512 + path.appliedD.length * 2, 0)
  );
}
