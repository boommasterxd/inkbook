import { NativeAnimation } from "motion";
import { ERASE_EASING } from "../../motion/transitions";
import type { SceneElementRecord } from "../types";

const FADE_ANIMATION = Symbol("inkbook-fade-animation");
type FadeNode = SVGElement & { [FADE_ANIMATION]?: NativeAnimation<string> };

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
  // Scene nodes belong to an isolated SVG document without Obsidian's setCssProps.
  const fadeNode = node as FadeNode;
  const previous = fadeNode[FADE_ANIMATION];
  // Motion commits the current native paint before stopping. Read only that
  // committed inline value for this admitted target, without a computed-style read.
  if (durationMs !== null && durationMs > 0) previous?.stop();
  else previous?.cancel();
  const current = previous === undefined ? "" : node.style.getPropertyValue("opacity");
  delete fadeNode[FADE_ANIMATION];
  // Motion commits the final keyframe inline after completion. Restore the
  // underlying SVG paint or pressure-group opacity before any replacement.
  if (node.style.getPropertyValue("opacity")) node.style.removeProperty("opacity");
  if (durationMs === null) return;
  const base = presentation === "opacity" ? (node.getAttribute("opacity") ?? "1") : "1";
  if (durationMs === 0) {
    const hiddenOpacity = "0";
    if (direction === "exit") node.style.setProperty("opacity", hiddenOpacity);
    return;
  }
  const hidden =
    generation === undefined
      ? "0"
      : `calc(${base} * (1 - var(--inkbook-history-active-${String(generation)}, 1)))`;
  const frames = direction === "enter" ? [current || hidden, base] : [current || base, hidden];
  fadeNode[FADE_ANIMATION] = new NativeAnimation({
    element: node,
    name: "opacity",
    keyframes: frames,
    duration: durationMs,
    ease: ERASE_EASING,
  });
}

function usesPaintOpacity(presentation: ElementFadePresentation): boolean {
  return presentation === "fill" || presentation === "stroke";
}

export function setHistoryFadeGate(
  node: SVGElement,
  generation: number,
  interrupted: boolean,
): void {
  const active = `--inkbook-history-active-${String(generation)}`;
  const visibility = `--inkbook-history-visibility-${String(generation)}`;
  if (interrupted) {
    const interruptedActive = "0";
    const interruptedVisibility = "visible";
    node.style.setProperty(active, interruptedActive);
    node.style.setProperty(visibility, interruptedVisibility);
  } else {
    node.style.removeProperty(active);
    node.style.removeProperty(visibility);
  }
}

export function showElementFadeRoots(entry: ElementFadeTargets): void {
  const roots = entry.group === null ? entry.paths.map((path) => path.node) : [entry.group];
  for (const root of roots)
    if (root.style.getPropertyValue("visibility")) root.style.removeProperty("visibility");
}

export function hideElementFadeRoots(
  entry: ElementFadeTargets,
  generation: number,
  onStyled: (index: number) => void,
): void {
  const visibility = `var(--inkbook-history-visibility-${String(generation)}, hidden)`;
  if (entry.group !== null) {
    entry.group.style.visibility = visibility;
    onStyled(0);
  } else {
    for (let index = 0; index < entry.paths.length; index += 1) {
      entry.paths[index]!.node.style.visibility = visibility;
      onStyled(index);
    }
  }
}
