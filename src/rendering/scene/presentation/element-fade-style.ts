import { NativeAnimation } from "motion";
import { ERASE_EASING } from "../../motion/transitions";
import type { SceneElementRecord } from "../types";

const FADE_ANIMATION = Symbol("inkbook-fade-animation");
type FadeProperty = "opacity" | "fill-opacity";
type FadeNode = SVGElement & {
  [FADE_ANIMATION]?: {
    readonly animation: NativeAnimation<string>;
    readonly property: FadeProperty;
  };
};

interface ElementFadeTargets {
  readonly displayedElement: SceneElementRecord["element"];
  readonly group: SVGElement | null;
  readonly paths: readonly { readonly node: SVGElement }[];
}

interface MountedElementFadeState extends ElementFadeTargets {
  fadeActive: boolean;
  fadePresentation: ElementFadePresentation | null;
}

export type ElementFadePresentation = "opacity" | "fill" | "stroke";
export type ElementFadeDirection = "enter" | "exit";

export function setMountedElementFade(
  entry: MountedElementFadeState,
  durationMs: number | null,
): void {
  const presentation = elementFadePresentation(entry);
  const previousPresentation = entry.fadePresentation ?? presentation;
  if (durationMs !== null && entry.fadeActive && previousPresentation !== presentation)
    setMountedElementFade(entry, null);
  const targetPresentation = durationMs === null ? previousPresentation : presentation;
  entry.fadeActive = durationMs !== null;
  entry.fadePresentation = durationMs === null ? null : presentation;
  for (let index = 0; index < elementFadeTargetCount(entry, targetPresentation); index += 1) {
    const node = elementFadeTarget(entry, index, targetPresentation);
    if (node !== undefined) setElementFadeNode(node, durationMs, targetPresentation);
  }
}

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
  const property: FadeProperty = presentation === "fill" ? "fill-opacity" : "opacity";
  const current = releaseFadeAnimation(fadeNode, property, durationMs);
  if (durationMs === null) return;
  const base = node.getAttribute(property) ?? "1";
  if (durationMs === 0) {
    const hiddenOpacity = "0";
    if (direction === "exit") node.style.setProperty(property, hiddenOpacity);
    return;
  }
  const hidden =
    generation === undefined
      ? "0"
      : `calc(${base} * (1 - var(--inkbook-history-active-${String(generation)}, 1)))`;
  const frames = direction === "enter" ? [current || hidden, base] : [current || base, hidden];
  fadeNode[FADE_ANIMATION] = {
    property,
    animation: new NativeAnimation({
      element: node,
      name: property === "fill-opacity" ? "fillOpacity" : "opacity",
      keyframes: frames,
      duration: durationMs,
      ease: ERASE_EASING,
    }),
  };
}

function releaseFadeAnimation(
  node: FadeNode,
  property: FadeProperty,
  durationMs: number | null,
): string {
  const previous = node[FADE_ANIMATION];
  // Motion commits the current native paint before stopping; only that owned
  // inline value is needed for interruption, without a computed-style read.
  if (durationMs !== null && durationMs > 0) previous?.animation.stop();
  else previous?.animation.cancel();
  const previousProperty = previous?.property ?? property;
  const current =
    previous === undefined || previousProperty !== property
      ? ""
      : node.style.getPropertyValue(property);
  delete node[FADE_ANIMATION];
  if (node.style.getPropertyValue(previousProperty)) node.style.removeProperty(previousProperty);
  return current;
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
