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

export function routeSceneDelta(delta: SceneStoreDelta, ports: SceneDeltaRoutingPorts): void {
  let firstVisibilityChange: SceneDeltaEntry | undefined;
  let hasMultipleVisibilityChanges = false;
  let orderIds: string[] | undefined;
  for (const affected of delta.affected) {
    if (affected.before === null && affected.after != null) {
      ports.content.setElementFade([affected.id], null);
    }
    let geometryDirty = false;
    let visibilityDirty = false;
    for (const domain of affected.domains) {
      if (domain === "geometry") {
        ports.content.markGeometry(affected.id);
        geometryDirty = true;
        visibilityDirty = true;
      } else if (domain === "paint") ports.content.markPaint(affected.id);
      else if (domain === "order") {
        orderIds ??= [];
        orderIds.push(affected.id);
      } else if (domain === "visibility") {
        releaseRemovedElement(affected.id, geometryDirty, ports);
        visibilityDirty = true;
      }
    }
    if (!visibilityDirty) continue;
    if (firstVisibilityChange === undefined) firstVisibilityChange = affected;
    else hasMultipleVisibilityChanges = true;
  }
  if (orderIds !== undefined) {
    ports.content.markOrders(orderIds);
    ports.markOrderVisibilityDirty();
  }
  if (firstVisibilityChange !== undefined) {
    invalidateVisibility(firstVisibilityChange, hasMultipleVisibilityChanges, ports);
  }
}

function invalidateVisibility(
  affected: SceneDeltaEntry,
  hasMultipleChanges: boolean,
  ports: SceneDeltaRoutingPorts,
): void {
  if (hasMultipleChanges) ports.visibility.invalidateForChanges();
  else {
    ports.visibility.invalidateForChanges(
      elementBounds(affected.before),
      currentBounds(affected, ports.store),
    );
  }
  ports.invalidateVisibility();
}

function releaseRemovedElement(
  id: string,
  geometryDirty: boolean,
  ports: SceneDeltaRoutingPorts,
): void {
  if (ports.store.get(id) !== undefined) return;
  if (!geometryDirty) ports.pathCache.invalidate(id);
  ports.visibility.releaseId(id);
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
