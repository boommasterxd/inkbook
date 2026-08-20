import type { ElementId, ObjectPortIdV1, SceneElementV1 } from "../model";
import { SCENE_RESOURCE_LIMITS_V1 } from "../scene/resource-limits";

export function validateElementAttachmentsV1(
  element: SceneElementV1,
  elementsById: ReadonlyMap<ElementId, SceneElementV1>,
  fanout: Map<ElementId, number>,
): void {
  if (element.kind !== "line" && element.kind !== "arrow") return;
  for (const endpoint of [element.geometry.start, element.geometry.end]) {
    const attachment = endpoint.attachment;
    if (attachment === null) continue;
    const target = elementsById.get(attachment.targetElementId);
    if (target === undefined || !isValidPort(target, attachment.portId)) {
      throw new TypeError("Endpoint attachment target or port is invalid.");
    }
    const count = (fanout.get(target.elementId) ?? 0) + 1;
    if (count > SCENE_RESOURCE_LIMITS_V1.maxAttachedEndpointsPerTarget) {
      throw new RangeError("Attachment fanout exceeds the V1 limit.");
    }
    fanout.set(target.elementId, count);
  }
}

function acceptsAreaPort(target: SceneElementV1): boolean {
  return [
    "rectangle",
    "ellipse",
    "triangle",
    "diamond",
    "octagon",
    "table",
  ].includes(target.kind);
}

function isValidPort(target: SceneElementV1, portId: ObjectPortIdV1): boolean {
  switch (portId) {
    case "area:north":
    case "area:east":
    case "area:south":
    case "area:west":
      return acceptsAreaPort(target);
    case "axes:origin":
    case "axes:x-positive":
    case "axes:y-positive":
      return target.kind === "axes-2d" || target.kind === "axes-3d";
    case "axes:z-positive":
      return target.kind === "axes-3d";
  }
}
