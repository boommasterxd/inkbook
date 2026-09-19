import { isPointElement, type ElementPathProfile } from "../../domain/geometry/element-path";
import type { InkElementV1 } from "../../domain/schema/public";
import { serializeElementPaths, serializeProfileElementPaths } from "./path-markup";

/** Retains at most one element's fragments, shared only by provably identical geometry. */
export function integrityOutlinePaths(
  element: InkElementV1,
  includeProfile: (profile: number) => boolean,
): readonly [string, string, string] {
  const fragments = new Map<ElementPathProfile, string>();
  const profiles = ["current", "rounded", "legacy"] as const;
  const texts = profiles.map((profile, index) => {
    if (!includeProfile(index)) return "";
    const geometry = geometryProfile(element, profile);
    let text = fragments.get(geometry);
    if (text === undefined) {
      const paths =
        geometry === "current"
          ? serializeElementPaths(element)
          : serializeProfileElementPaths(element, geometry);
      text = paths.join("");
      fragments.set(geometry, text);
    }
    const flat =
      profile === "legacy" &&
      element.kind !== "stroke" &&
      element.kind !== "straight-highlighter" &&
      !isPointElement(element) &&
      element.style.outlineStyle !== "dotted";
    return flat ? text.replaceAll('stroke-linecap="round"', 'stroke-linecap="butt"') : text;
  });
  const fallback = texts.find((text) => text.length > 0) ?? "";
  return [texts[0] || fallback, texts[1] || fallback, texts[2] || fallback];
}

function geometryProfile(element: InkElementV1, profile: ElementPathProfile): ElementPathProfile {
  if (profile === "current") return profile;
  if (element.kind === "coordinate-system") return "rounded";
  if (element.kind !== "arrow") return "current";
  const nodes = [element.startNode, element.endNode];
  if (profile === "legacy" && nodes.some((node) => node !== "none" && node !== "arrow")) {
    return "legacy";
  }
  return nodes.includes("arrow") ? "rounded" : "current";
}
