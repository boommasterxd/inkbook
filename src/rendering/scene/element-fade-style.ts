import { effectiveStrokeWidth } from "../../domain/geometry/bounds";
import { EASING_TOKENS, type ElementFadeMode } from "../motion/transitions";
import type { SceneElementRecord } from "./types";

interface ElementFadeTargets {
  readonly displayedElement: SceneElementRecord["element"];
  readonly group: SVGElement | null;
  readonly paths: readonly { readonly node: SVGElement }[];
}

export type ElementFadePresentation = "blur" | "opacity" | "fill" | "stroke";

export function elementFadePresentation(
  entry: ElementFadeTargets,
  mode: ElementFadeMode,
): ElementFadePresentation {
  const element = entry.displayedElement;
  if (mode === "blur") return "blur";
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
  element: SceneElementRecord["element"],
  presentation: ElementFadePresentation = "blur",
): void {
  const animated = durationMs !== null && durationMs > 0;
  const animation = elementFadeAnimation(presentation);
  node.style.animation = animated
    ? `${animation} ${String(durationMs)}ms ${EASING_TOKENS.erase} forwards`
    : "";
  const filter =
    animated && presentation === "blur" ? `blur(${String(elementEraseBlur(element))}px)` : "";
  if ((node.style.filter || "") !== filter) node.style.filter = filter;
  // Start from the existing paint alpha or root opacity; pressure group alpha remains intact.
  node.style.opacity = durationMs === 0 ? "0" : "";
}

function usesPaintOpacity(presentation: ElementFadePresentation): boolean {
  return presentation === "fill" || presentation === "stroke";
}

function elementFadeAnimation(presentation: ElementFadePresentation): string {
  return presentation === "blur" ? "inkbook-element-erase" : `inkbook-element-${presentation}-exit`;
}

function elementEraseBlur(element: SceneElementRecord["element"]): number {
  if (
    "fillColor" in element.style &&
    element.style.fillColor !== null &&
    element.style.fillOpacity > 0
  )
    return 50;
  const width =
    element.kind === "stroke" || element.kind === "straight-highlighter"
      ? effectiveStrokeWidth(element)
      : element.style.outlineWidth;
  return Math.min(50, width * 10);
}
