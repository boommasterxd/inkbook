import type { SettingDefinitionGroup } from "obsidian";

import {
  CLOSED_SHAPE_TOOLS,
  type ClosedShapeToolV1,
  type OutlineOnlyToolV1,
} from "../../domain/settings";
import type { SettingsControlKey } from "./control-values";
import { resetAction, sentenceCaseLabel } from "./definition-helpers";
import {
  toolSectionDefinition,
  type ToolSectionSpec,
  type ToolSectionValues,
} from "./tool-section";

const STROKE_DESCRIPTIONS = {
  color: "Choose the color used by newly created strokes.",
  "stroke-width": "Choose the width used by newly created strokes.",
  opacity: "Set the opacity used by newly created strokes.",
  "pressure-enabled": "Use pen pressure to vary the width of newly created strokes.",
} as const;

const OUTLINE_DESCRIPTIONS = {
  "outline-color": "Choose the outline color used by newly created elements.",
  "outline-width": "Choose the outline width used by newly created elements.",
  "outline-style": "Choose the outline pattern used by newly created elements.",
  "outline-opacity": "Set the outline opacity used by newly created elements.",
  "fill-color": "Choose the fill color used by newly created shapes.",
  "fill-opacity": "Set the fill opacity used by newly created shapes.",
  "arrow-start-node": "Choose the start node used by newly created arrows.",
  "arrow-end-node": "Choose the end node used by newly created arrows.",
  "coordinate-dimension": "Choose two or three dimensions for new coordinate systems.",
  "table-columns": "Set the number of columns used by newly created tables.",
} as const;

export function drawingToolsGroup(
  values: ToolSectionValues,
  reset: () => void,
): SettingDefinitionGroup<SettingsControlKey> {
  return toolDefinitionsGroup("Drawing tools", drawingToolSpecs(), values, reset);
}

export function shapesAndStructuresGroup(
  values: ToolSectionValues,
  reset: () => void,
): SettingDefinitionGroup<SettingsControlKey> {
  return toolDefinitionsGroup("Shapes and structures", shapeToolSpecs(), values, reset);
}

function toolDefinitionsGroup(
  heading: string,
  specs: readonly ToolSectionSpec[],
  values: ToolSectionValues,
  reset: () => void,
): SettingDefinitionGroup<SettingsControlKey> {
  return {
    type: "group",
    heading,
    cls: "inkbook-settings-tool-group",
    items: [
      ...specs.map((spec) => toolSectionDefinition(spec, values)),
      resetAction("Reset group to defaults", reset),
    ],
  };
}

function drawingToolSpecs(): readonly ToolSectionSpec[] {
  return [
    strokeSpec({
      description: "Configure defaults for newly created pen strokes.",
      name: "Pen",
      pressure: true,
      root: "pen",
      tool: "draw",
    }),
    strokeSpec({
      description: "Configure defaults for newly created freehand highlights.",
      name: "Highlighter",
      pressure: false,
      root: "highlighter",
      tool: "highlighter",
    }),
    strokeSpec({
      description: "Configure defaults for newly created straight highlights.",
      name: "Straight highlighter",
      pressure: false,
      root: "straightHighlighter",
      tool: "straight-highlighter",
    }),
    {
      name: "Eraser",
      description: "Configure the screen-relative radius used by the eraser.",
      tool: "eraser",
      controlDescriptions: {
        "eraser-radius": "Set the screen-relative radius used by the eraser.",
      },
      controlKeys: { "eraser-radius": "toolDefaults.eraser.radius" },
    },
  ];
}

interface StrokeSpecOptions {
  readonly description: string;
  readonly name: string;
  readonly pressure: boolean;
  readonly root: "pen" | "highlighter" | "straightHighlighter";
  readonly tool: "draw" | "highlighter" | "straight-highlighter";
}

function strokeSpec(options: StrokeSpecOptions): ToolSectionSpec {
  const controlKeys: Record<string, SettingsControlKey> = {
    color: `toolDefaults.${options.root}.color`,
    "stroke-width": `toolDefaults.${options.root}.width`,
    opacity: `toolDefaults.${options.root}.opacity`,
  };
  if (options.pressure) controlKeys["pressure-enabled"] = "toolDefaults.pen.pressureEnabled";
  return {
    controlDescriptions: STROKE_DESCRIPTIONS,
    controlKeys,
    description: options.description,
    name: options.name,
    tool: options.tool,
  };
}

function shapeToolSpecs(): readonly ToolSectionSpec[] {
  const closedShapes = CLOSED_SHAPE_TOOLS.map((tool) => shapeSpec(tool));
  return [
    shapeSpec("line"),
    shapeSpec("arrow"),
    ...closedShapes,
    shapeSpec("coordinate-system"),
    shapeSpec("table"),
  ];
}

function shapeSpec(tool: ClosedShapeToolV1 | OutlineOnlyToolV1): ToolSectionSpec {
  const name = sentenceCaseLabel(tool);
  return {
    name,
    description: `Configure defaults for newly created ${name.toLowerCase()} elements.`,
    tool,
    controlDescriptions: OUTLINE_DESCRIPTIONS,
    controlKeys: shapeControlKeys(tool),
  };
}

function shapeControlKeys(
  tool: ClosedShapeToolV1 | OutlineOnlyToolV1,
): Readonly<Record<string, SettingsControlKey>> {
  const root = `toolDefaults.shapes.${tool}` as const;
  const keys: Record<string, SettingsControlKey> = {
    "outline-color": `${root}.outlineColor`,
    "outline-width": `${root}.outlineWidth`,
    "outline-style": `${root}.outlineStyle`,
    "outline-opacity": `${root}.outlineOpacity`,
  };
  if ((CLOSED_SHAPE_TOOLS as readonly string[]).includes(tool)) {
    keys["fill-color"] = `${root}.fillColor`;
    keys["fill-opacity"] = `${root}.fillOpacity`;
  }
  if (tool === "arrow") {
    keys["arrow-start-node"] = "toolDefaults.arrow.startNode";
    keys["arrow-end-node"] = "toolDefaults.arrow.endNode";
  }
  if (tool === "coordinate-system") {
    keys["coordinate-dimension"] = "toolDefaults.coordinateSystem.dimension";
  }
  if (tool === "table") keys["table-columns"] = "toolDefaults.table.columns";
  return keys;
}
