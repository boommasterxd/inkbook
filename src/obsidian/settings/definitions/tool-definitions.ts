import { createEnglishLocalization, type Translator } from "../../../domain/localization";
import type { SettingDefinitionGroup } from "obsidian";

import {
  CLOSED_SHAPE_TOOLS,
  type ClosedShapeToolV1,
  type OutlineOnlyToolV1,
} from "../../../domain/settings";
import type { SettingsControlKey } from "../control-values";
import { resetAction } from "./definition-helpers";
import { createLabels } from "./general-definitions";
import {
  toolSectionDefinition,
  type ToolSectionSpec,
  type ToolSectionValues,
} from "./tool-section";

const strokeDescriptions = (t: Translator) =>
  ({
    color: t("settings.controls.strokeColorHelp"),
    "stroke-width": t("settings.controls.strokeWidthHelp"),
    opacity: t("settings.controls.strokeOpacityHelp"),
    "pressure-enabled": t("settings.controls.pressureHelp"),
    "hold-to-shape-enabled": t("settings.controls.toolHoldHelp"),
  }) as const;

const outlineDescriptions = (t: Translator) =>
  ({
    "outline-color": t("settings.controls.outlineColorHelp"),
    "outline-width": t("settings.controls.outlineWidthHelp"),
    "outline-style": t("settings.controls.outlineStyleHelp"),
    "outline-opacity": t("settings.controls.outlineOpacityHelp"),
    "fill-color": t("settings.controls.fillColorHelp"),
    "fill-opacity": t("settings.controls.fillOpacityHelp"),
    "arrow-start-node": t("settings.controls.arrowStartHelp"),
    "arrow-end-node": t("settings.controls.arrowEndHelp"),
    "coordinate-dimension": t("settings.controls.dimensionHelp"),
    "table-columns": t("settings.controls.tableColumnsHelp"),
    "snapping-enabled": t("settings.controls.toolSnappingHelp"),
  }) as const;

export function drawingToolsGroup(
  values: ToolSectionValues,
  reset: () => void | Promise<void>,
): SettingDefinitionGroup<SettingsControlKey> {
  const t = values.t ?? createEnglishLocalization().t;
  return toolDefinitionsGroup(
    t("settings.controls.drawingTools"),
    drawingToolSpecs(t),
    values,
    reset,
  );
}

export function shapesAndStructuresGroup(
  values: ToolSectionValues,
  reset: () => void | Promise<void>,
): SettingDefinitionGroup<SettingsControlKey> {
  const t = values.t ?? createEnglishLocalization().t;
  return toolDefinitionsGroup(
    t("settings.controls.shapesStructures"),
    shapeToolSpecs(t),
    values,
    reset,
  );
}

function toolDefinitionsGroup(
  heading: string,
  specs: readonly ToolSectionSpec[],
  values: ToolSectionValues,
  reset: () => void | Promise<void>,
): SettingDefinitionGroup<SettingsControlKey> {
  const t = values.t ?? createEnglishLocalization().t;
  return {
    type: "group",
    heading,
    cls: "inkbook-settings-tool-group",
    items: [
      ...specs.map((spec) => toolSectionDefinition(spec, values)),
      resetAction(t("settings.controls.resetGroup"), reset, t),
    ],
  };
}

function drawingToolSpecs(t: Translator): readonly ToolSectionSpec[] {
  return [
    {
      name: t("settings.controls.select"),
      description: t("settings.controls.selectHelp"),
      tool: "select",
      controlDescriptions: {
        "selection-area": t("settings.controls.selectionAreaHelp"),
        "selection-inclusion": t("settings.controls.selectionInclusionHelp"),
      },
      controlKeys: {
        "selection-area": "toolDefaults.select.area",
        "selection-inclusion": "toolDefaults.select.inclusion",
      },
    },
    strokeSpec(
      {
        description: t("settings.controls.penHelp"),
        name: t("settings.controls.pen"),
        pressure: true,
        root: "pen",
        tool: "draw",
      },
      t,
    ),
    strokeSpec(
      {
        description: t("settings.controls.highlighterHelp"),
        name: t("settings.controls.highlighter"),
        pressure: false,
        root: "highlighter",
        tool: "highlighter",
      },
      t,
    ),
    strokeSpec(
      {
        description: t("settings.controls.straightHighlighterHelp"),
        name: t("settings.controls.straightHighlighter"),
        pressure: false,
        root: "straightHighlighter",
        tool: "straight-highlighter",
      },
      t,
    ),
    textSpec(t),
    {
      name: t("settings.controls.eraser"),
      description: t("settings.controls.eraserHelp"),
      tool: "eraser",
      controlDescriptions: {
        "eraser-radius": t("settings.controls.eraserRadiusHelp"),
      },
      controlKeys: { "eraser-radius": "toolDefaults.eraser.radius" },
    },
  ];
}

function textSpec(t: Translator): ToolSectionSpec {
  return {
    name: t("settings.controls.text"),
    description: t("settings.controls.textHelp"),
    tool: "text",
    controlKeys: {
      "copy-text-fields-as-text": "copyTextFieldsAsText",
      "text-font-family": "toolDefaults.text.fontFamily",
      "text-font-size": "toolDefaults.text.fontSize",
      color: "toolDefaults.text.color",
      opacity: "toolDefaults.text.opacity",
      "text-bold": "toolDefaults.text.bold",
      "text-italic": "toolDefaults.text.italic",
      "text-underline": "toolDefaults.text.underline",
      "text-strikethrough": "toolDefaults.text.strikethrough",
      "text-alignment": "toolDefaults.text.alignment",
      "text-background-color": "toolDefaults.text.backgroundColor",
      "text-background-opacity": "toolDefaults.text.backgroundOpacity",
    },
    controlDescriptions: {
      "copy-text-fields-as-text": t("settings.controls.copyTextFieldsAsTextHelp"),
      "text-font-family": t("settings.controls.textFontFamilyHelp"),
      "text-font-size": t("settings.controls.textFontSizeHelp"),
      color: t("settings.controls.textColorHelp"),
      opacity: t("settings.controls.textOpacityHelp"),
      "text-bold": t("settings.controls.textBoldHelp"),
      "text-italic": t("settings.controls.textItalicHelp"),
      "text-underline": t("settings.controls.textUnderlineHelp"),
      "text-strikethrough": t("settings.controls.textStrikethroughHelp"),
      "text-alignment": t("settings.controls.textAlignmentHelp"),
      "text-background-color": t("settings.controls.textBackgroundColorHelp"),
      "text-background-opacity": t("settings.controls.textBackgroundOpacityHelp"),
    },
  };
}

interface StrokeSpecOptions {
  readonly description: string;
  readonly name: string;
  readonly pressure: boolean;
  readonly root: "pen" | "highlighter" | "straightHighlighter";
  readonly tool: "draw" | "highlighter" | "straight-highlighter";
}

function strokeSpec(options: StrokeSpecOptions, t: Translator): ToolSectionSpec {
  const controlKeys: Record<string, SettingsControlKey> = {
    color: `toolDefaults.${options.root}.color`,
    "stroke-width": `toolDefaults.${options.root}.width`,
    opacity: `toolDefaults.${options.root}.opacity`,
  };
  if (options.pressure) controlKeys["pressure-enabled"] = "toolDefaults.pen.pressureEnabled";
  if (options.tool === "draw") {
    controlKeys["hold-to-shape-enabled"] = "toolDefaults.pen.holdToShapeEnabled";
  }
  return {
    controlDescriptions: strokeDescriptions(t),
    controlKeys,
    description: options.description,
    name: options.name,
    tool: options.tool,
  };
}

function shapeToolSpecs(t: Translator): readonly ToolSectionSpec[] {
  const closedShapes = CLOSED_SHAPE_TOOLS.map((tool) => shapeSpec(tool, t));
  return [
    shapeSpec("line", t),
    shapeSpec("arrow", t),
    ...closedShapes,
    shapeSpec("coordinate-system", t),
    shapeSpec("table", t),
  ];
}

function shapeSpec(tool: ClosedShapeToolV1 | OutlineOnlyToolV1, t: Translator): ToolSectionSpec {
  const name = createLabels([tool], t)[tool] ?? tool;
  return {
    name,
    description: t("settings.controls.shapeHelp", { shape: name }),
    tool,
    controlDescriptions: outlineDescriptions(t),
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
  if (tool === "line" || tool === "arrow") {
    keys["snapping-enabled"] = `toolDefaults.${tool}.snappingEnabled`;
  }
  return keys;
}
