import { calculateElementBounds } from "../../domain/geometry/public";
import type { Bounds } from "../../domain/geometry/public";
import type { SceneContentRenderer } from "./content-renderer";
import type { ScenePathCache } from "./path-cache";
import type { SceneDeltaEntry, SceneStoreDelta, SceneStorePort } from "./types";
import type { SceneVisibilityState } from "./visibility-state";
import type { DetachedSceneElementCache } from "./detached-element-cache";

export interface SceneDeltaRoutingPorts {
  readonly content: SceneContentRenderer;
  readonly detachedCache?: DetachedSceneElementCache;
  readonly invalidateVisibility: () => void;
  readonly markOrderVisibilityDirty: () => void;
  readonly pathCache: ScenePathCache;
  readonly store: SceneStorePort;
  readonly visibility: SceneVisibilityState;
}

export function routeSceneDelta(delta: SceneStoreDelta, ports: SceneDeltaRoutingPorts): void {
  let visibilityChanges: SceneDeltaEntry[] | undefined;
  let orderIds: string[] | undefined;
  let onlyNewOrder = true;
  for (const affected of delta.affected) {
    const localMembership = completeMembershipChange(affected, ports.store);
    prepareMembershipFade(affected, delta.historyReplay, ports.content);
    let geometryDirty = false;
    let visibilityDirty = false;
    for (const domain of affected.domains) {
      if (domain === "geometry") {
        ports.content.markGeometry(affected.id);
        geometryDirty = true;
        visibilityDirty = true;
      } else if (domain === "paint") ports.content.markPaint(affected.id);
      else if (domain === "order") {
        if (localMembership) continue;
        orderIds ??= [];
        orderIds.push(affected.id);
        onlyNewOrder &&= affected.before === null && affected.after != null;
      } else if (domain === "visibility") {
        releaseRemovedElement(affected.id, geometryDirty, ports);
        visibilityDirty = true;
      }
    }
    if (!visibilityDirty) continue;
    visibilityChanges ??= [];
    visibilityChanges.push(affected);
  }
  if (orderIds !== undefined) {
    ports.content.markOrders(orderIds);
    if (orderIds.length !== 1 || !onlyNewOrder) ports.markOrderVisibilityDirty();
  }
  if (visibilityChanges !== undefined) {
    invalidateVisibility(visibilityChanges, ports);
  }
  invalidateDetachedElements(delta, ports);
}

function prepareMembershipFade(
  affected: SceneDeltaEntry,
  historyReplay: boolean | undefined,
  content: SceneContentRenderer,
): void {
  if (affected.before === null && affected.after != null && historyReplay !== true)
    content.setElementFade([affected.id], null);
  if (affected.after === null) content.prepareElementRemoval(affected.id);
}

function invalidateDetachedElements(delta: SceneStoreDelta, ports: SceneDeltaRoutingPorts): void {
  if (ports.detachedCache === undefined) return;
  for (const affected of delta.affected) {
    if (affected.domains.includes("geometry") || ports.store.get(affected.id) === undefined) {
      ports.detachedCache.invalidate(affected.id);
    }
  }
}

function invalidateVisibility(
  changes: readonly SceneDeltaEntry[],
  ports: SceneDeltaRoutingPorts,
): void {
  if (
    changes.length > 1 &&
    changes.some((change) => change.before === undefined || change.after === undefined)
  )
    ports.visibility.invalidateForChanges();
  else {
    for (const affected of changes)
      ports.visibility.invalidateForChanges(
        affected.beforeBounds ?? elementBounds(affected.before),
        affected.afterBounds ?? currentBounds(affected, ports.store),
        affected.before !== undefined && affected.after !== undefined ? affected.id : undefined,
      );
  }
  ports.invalidateVisibility();
}

function completeMembershipChange(change: SceneDeltaEntry, store: SceneStorePort): boolean {
  if (!change.domains.includes("visibility")) return false;
  if (change.before != null && change.after === null) return store.get(change.id) === undefined;
  return (
    change.before === null && change.after != null && store.get(change.id)?.element === change.after
  );
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
