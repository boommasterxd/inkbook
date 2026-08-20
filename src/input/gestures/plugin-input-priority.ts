import type { InputHit } from "./secondary-button-router";
import type { PointerKind } from "./gesture-profile";

type ActiveTool =
  | "cursor"
  | "lasso"
  | "pen"
  | "highlighter"
  | "eraser"
  | "shape"
  | "line"
  | "construction";

export type InitialPointerIntent = Readonly<{
  pointerKind: PointerKind;
  button: number;
  hit: InputHit;
  activeTool: ActiveTool;
}>;

export type PointerOwnershipDecision = Readonly<{
  owner: "host" | "plugin";
  action: "native" | "select-plugin-target" | "manipulate-handle" | "draw";
  preventDefault: boolean;
  stopPropagation: boolean;
  frozenHit: InputHit;
}>;

const DRAWING_TOOLS: ReadonlySet<ActiveTool> = new Set([
  "pen",
  "highlighter",
  "eraser",
  "shape",
  "line",
  "construction",
]);

export function decideInitialPointerOwnership(
  intent: InitialPointerIntent,
): PointerOwnershipDecision {
  if (intent.button !== 0) {
    return hostDecision(intent.hit);
  }
  if (intent.hit.kind === "plugin-handle") {
    return pluginDecision("manipulate-handle", intent.hit);
  }
  if (intent.pointerKind === "touch" && intent.hit.kind === "plugin-element") {
    return pluginDecision("select-plugin-target", intent.hit);
  }
  if (
    intent.hit.kind === "plugin-element" &&
    (intent.activeTool === "cursor" || intent.activeTool === "lasso")
  ) {
    return pluginDecision("select-plugin-target", intent.hit);
  }
  if (
    intent.pointerKind === "pen" &&
    (intent.hit.kind === "native-markdown" ||
      intent.hit.kind === "empty-note") &&
    DRAWING_TOOLS.has(intent.activeTool)
  ) {
    return pluginDecision("draw", intent.hit);
  }
  return hostDecision(intent.hit);
}

function pluginDecision(
  action: "select-plugin-target" | "manipulate-handle" | "draw",
  hit: InputHit,
): PointerOwnershipDecision {
  return {
    owner: "plugin",
    action,
    preventDefault: true,
    stopPropagation: true,
    frozenHit: hit,
  };
}

function hostDecision(hit: InputHit): PointerOwnershipDecision {
  return {
    owner: "host",
    action: "native",
    preventDefault: false,
    stopPropagation: false,
    frozenHit: hit,
  };
}
