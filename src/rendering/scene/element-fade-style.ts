import { EASING_TOKENS } from "../motion/transitions";
import type { SceneElementRecord } from "./types";

interface ElementFadeTargets {
  readonly displayedElement: SceneElementRecord["element"];
  readonly group: SVGElement | null;
  readonly paths: readonly { readonly node: SVGElement }[];
}

export type ElementFadePresentation = "opacity" | "fill" | "stroke";

export function elementFadePresentation(entry: ElementFadeTargets): ElementFadePresentation {
  const element = entry.displayedElement;
  if (element.kind !== "stroke" && element.kind !== "straight-highlighter") return "opacity";
  // Multiple pressure paths must composite together while their group fades.
  if (element.kind === "stroke" && element.style.pressureEnabled && entry.paths.length !== 1)
    return "opacity";
  return element.kind === "stroke" && element.style.pressureEnabled ? "fill" : "stroke";
}

export function elementFadeTargetCount(
  entry: ElementFadeTargets,
  presentation: ElementFadePresentation,
): number {
  return usesPaintOpacity(presentation) || entry.group === null ? entry.paths.length : 1;
}

export function elementFadeTarget(
  entry: ElementFadeTargets,
  index: number,
  presentation: ElementFadePresentation,
): SVGElement | undefined {
  return usesPaintOpacity(presentation)
    ? entry.paths[index]?.node
    : (entry.group ?? entry.paths[index]?.node);
}

export function setElementFadeNode(
  node: SVGElement,
  durationMs: number | null,
  presentation: ElementFadePresentation,
): void {
  const animated = durationMs !== null && durationMs > 0;
  node.style.animation = animated
    ? `inkbook-element-${presentation}-exit ${String(durationMs)}ms ${EASING_TOKENS.erase} forwards`
    : "";
  // Start from the existing paint alpha or root opacity; pressure group alpha remains intact.
  node.style.opacity = durationMs === 0 ? "0" : "";
}

function usesPaintOpacity(presentation: ElementFadePresentation): boolean {
  return presentation === "fill" || presentation === "stroke";
}
