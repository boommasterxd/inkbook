import { EASING_TOKENS } from "../motion/transitions";
import type { SceneElementRecord } from "./types";

interface ElementFadeTargets {
  readonly displayedElement: SceneElementRecord["element"];
  readonly group: SVGElement | null;
  readonly paths: readonly { readonly node: SVGElement }[];
}

export type ElementFadePresentation = "opacity" | "fill" | "stroke";
export type ElementFadeDirection = "enter" | "exit";

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
  direction: ElementFadeDirection = "exit",
  generation?: number,
): void {
  const animated = durationMs !== null && durationMs > 0;
  const duration =
    generation === undefined
      ? `${String(durationMs)}ms`
      : `var(--inkbook-history-duration-${String(generation)}, ${String(durationMs)}ms)`;
  const animation = animated
    ? `inkbook-element-${presentation}-${direction} ${duration} ${EASING_TOKENS.erase} ${direction === "enter" ? "reverse both" : "forwards"}`
    : "";
  // Start from the existing paint alpha or root opacity; pressure group alpha remains intact.
  const opacity = durationMs === 0 && direction === "exit" ? "0" : "";
  if (node.style.getPropertyValue("animation") !== animation) node.style.animation = animation;
  if (node.style.getPropertyValue("opacity") !== opacity) node.style.opacity = opacity;
}

function usesPaintOpacity(presentation: ElementFadePresentation): boolean {
  return presentation === "fill" || presentation === "stroke";
}

export function setHistoryFadeGate(
  node: SVGElement,
  generation: number,
  interrupted: boolean,
): void {
  const duration = `--inkbook-history-duration-${String(generation)}`;
  const visibility = `--inkbook-history-visibility-${String(generation)}`;
  if (interrupted) {
    const interruptedDuration = "0ms";
    const interruptedVisibility = "visible";
    node.style.setProperty(duration, interruptedDuration);
    node.style.setProperty(visibility, interruptedVisibility);
  } else {
    node.style.removeProperty(duration);
    node.style.removeProperty(visibility);
  }
}
