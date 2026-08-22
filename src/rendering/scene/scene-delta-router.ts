import { calculateElementBounds } from "../../domain/geometry/public";
import type { Bounds } from "../../domain/geometry/public";
import type { SceneContentRenderer } from "./content-renderer";
import type { ScenePathCache } from "./path-cache";
import type { SceneDeltaEntry, SceneStoreDelta, SceneStorePort } from "./types";
import type { SceneVisibilityState } from "./visibility-state";

export interface SceneDeltaRoutingPorts {
  readonly content: SceneContentRenderer;
  readonly invalidateVisibility: () => void;
  readonly markOrderVisibilityDirty: () => void;
  readonly pathCache: ScenePathCache;
  readonly store: SceneStorePort;
  readonly visibility: SceneVisibilityState;
}

export function routeSceneDeltaDomain(
  affected: SceneDeltaEntry,
  domain: SceneStoreDelta["affected"][number]["domains"][number],
  ports: SceneDeltaRoutingPorts,
): void {
  const { id } = affected;
  if (domain === "geometry") {
    ports.content.markGeometry(id);
    invalidateVisibility(affected, ports);
  } else if (domain === "paint") ports.content.markPaint(id);
  else if (domain === "order") {
    ports.content.markOrder(id);
    ports.markOrderVisibilityDirty();
    ports.content.cancelPendingVisibility();
  } else if (domain === "visibility") {
    if (ports.store.get(id) === undefined) {
      ports.pathCache.invalidate(id);
      ports.visibility.releaseId(id);
    }
    invalidateVisibility(affected, ports);
  }
}

function invalidateVisibility(affected: SceneDeltaEntry, ports: SceneDeltaRoutingPorts): void {
  ports.visibility.invalidateCandidatesForChange(
    elementBounds(affected.before),
    currentBounds(affected, ports.store),
  );
  ports.invalidateVisibility();
}

function currentBounds(
  affected: SceneDeltaEntry,
  store: SceneStorePort,
): Bounds | null | undefined {
  if (affected.after === undefined) return undefined;
  if (affected.after === null) return null;
  return store.get(affected.id)?.bounds ?? calculateElementBounds(affected.after);
}

function elementBounds(element: SceneDeltaEntry["before"]): Bounds | null | undefined {
  return element === undefined || element === null ? element : calculateElementBounds(element);
}
