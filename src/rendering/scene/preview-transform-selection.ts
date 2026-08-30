import type { Bounds } from "../../domain/geometry/public";
import type { ArrowNodeV1, InkElementV1 } from "../../domain/schema/public";
import type { SceneCamera, SceneStorePort, SceneViewport } from "./types";

const MAX_PREVIEW_PATHS = 256;

interface Candidate {
  readonly distance: number;
  readonly id: string;
  readonly paths: number;
}

export function selectViewportNearPreviewIds(
  ids: readonly string[],
  store: SceneStorePort,
  viewport: SceneViewport | undefined,
  camera: SceneCamera,
): readonly string[] {
  const candidates: Candidate[] = [];
  for (const id of ids) {
    const record = store.get(id);
    if (record === undefined) continue;
    candidates.push({
      distance: distanceToViewport(record.bounds, viewport, camera),
      id,
      paths: elementPathCount(record.element),
    });
  }
  candidates.sort(
    (left, right) => left.distance - right.distance || left.id.localeCompare(right.id),
  );
  const selected: string[] = [];
  let paths = 0;
  for (const candidate of candidates) {
    if (paths + candidate.paths > MAX_PREVIEW_PATHS) continue;
    selected.push(candidate.id);
    paths += candidate.paths;
  }
  return selected;
}

function distanceToViewport(
  bounds: Bounds,
  viewport: SceneViewport | undefined,
  camera: SceneCamera,
): number {
  if (viewport === undefined) return 0;
  const centerX = ((bounds.minX + bounds.maxX) / 2 + camera.x) * camera.zoom;
  const centerY = ((bounds.minY + bounds.maxY) / 2) * camera.zoom;
  const viewportCenterX = viewport.left + viewport.width / 2;
  const viewportCenterY = viewport.top + viewport.height / 2;
  return Math.hypot(centerX - viewportCenterX, centerY - viewportCenterY);
}

function elementPathCount(element: InkElementV1): number {
  if (element.kind !== "arrow") return 1;
  return 1 + Number(isFilledNode(element.startNode)) + Number(isFilledNode(element.endNode));
}

function isFilledNode(node: ArrowNodeV1): boolean {
  return node === "triangle" || node === "diamond" || node === "circle";
}
