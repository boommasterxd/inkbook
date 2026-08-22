import type {
  Setting,
  SettingDefinition,
  SettingDefinitionGroup,
  SettingDefinitionRender,
} from "obsidian";

import {
  ARROW_NODES,
  CLOSED_SHAPE_TOOLS,
  OUTLINE_ONLY_TOOLS,
  OUTLINE_STYLES,
  OUTLINE_WIDTHS,
  PEN_WIDTHS,
  type ClosedShapeToolV1,
  type OutlineOnlyToolV1,
} from "../../domain/settings";
import type { SettingsControlKey } from "./control-values";
import { COLOR_OPTIONS, dropdown, sentenceCaseLabel, slider, toggle } from "./definition-helpers";

const numericOptions = (values: readonly number[]): Record<string, string> =>
  Object.fromEntries(values.map((value) => [String(value), String(value)]));

export function penItems(): SettingDefinition<SettingsControlKey>[] {
  return [
    dropdown(
      "toolDefaults.pen.color",
      "Color",
      "Choose the color for new pen strokes.",
      COLOR_OPTIONS,
    ),
    dropdown(
      "toolDefaults.pen.width",
      "Width",
      "Choose the width for new pen strokes.",
      numericOptions(PEN_WIDTHS),
    ),
    slider(
      "toolDefaults.pen.opacity",
      "Opacity",
      "Set the opacity for new pen strokes.",
      0,
      1,
      0.05,
    ),
    toggle(
      "toolDefaults.pen.pressureEnabled",
      "Pressure sensitivity",
      "Use pen pressure for new pen strokes.",
    ),
  ];
}

export function highlighterItems(straight: boolean): SettingDefinition<SettingsControlKey>[] {
  const root = straight ? "toolDefaults.straightHighlighter" : "toolDefaults.highlighter";
  const kind = straight ? "straight highlights" : "highlights";
  return [
    dropdown(`${root}.color`, "Color", `Choose the color for new ${kind}.`, COLOR_OPTIONS),
    dropdown(
      `${root}.width`,
      "Width",
      `Choose the base width for new ${kind}.`,
      numericOptions(PEN_WIDTHS),
    ),
    slider(`${root}.opacity`, "Opacity", `Set the opacity for new ${kind}.`, 0, 1, 0.05),
  ];
}

function shapeItems(
  tool: ClosedShapeToolV1 | OutlineOnlyToolV1,
): SettingDefinition<SettingsControlKey>[] {
  const root = `toolDefaults.shapes.${tool}` as const;
  const items: SettingDefinition<SettingsControlKey>[] = [
    dropdown(
      `${root}.outlineColor`,
      "Outline color",
      "Choose the outline color for new shapes.",
      COLOR_OPTIONS,
    ),
    dropdown(
      `${root}.outlineWidth`,
      "Outline width",
      "Choose the outline width for new shapes.",
      numericOptions(OUTLINE_WIDTHS),
    ),
    dropdown(
      `${root}.outlineStyle`,
      "Outline style",
      "Choose the outline pattern for new shapes.",
      Object.fromEntries(OUTLINE_STYLES.map((value) => [value, sentenceCaseLabel(value)])),
    ),
    slider(
      `${root}.outlineOpacity`,
      "Outline opacity",
      "Set the outline opacity for new shapes.",
      0,
      1,
      0.05,
    ),
  ];
  if ((CLOSED_SHAPE_TOOLS as readonly string[]).includes(tool)) {
    items.push(
      dropdown(`${root}.fillColor`, "Fill color", "Choose the fill color for new shapes.", {
        none: "None",
        ...COLOR_OPTIONS,
      }),
      slider(
        `${root}.fillOpacity`,
        "Fill opacity",
        "Set the fill opacity for new shapes.",
        0,
        1,
        0.05,
      ),
    );
  }
  if (tool === "arrow") {
    const nodeOptions = Object.fromEntries(
      ARROW_NODES.map((value) => [value, sentenceCaseLabel(value)]),
    );
    items.push(
      dropdown(
        "toolDefaults.arrow.startNode",
        "Start node",
        "Choose the start node for new arrows.",
        nodeOptions,
      ),
      dropdown(
        "toolDefaults.arrow.endNode",
        "End node",
        "Choose the end node for new arrows.",
        nodeOptions,
      ),
    );
  }
  if (tool === "coordinate-system") {
    items.push(
      dropdown(
        "toolDefaults.coordinateSystem.dimension",
        "Dimension",
        "Choose the dimension for new coordinate systems.",
        { "2d": "2D", "3d": "3D" },
      ),
    );
  }
  if (tool === "table") {
    items.push(
      slider(
        "toolDefaults.table.columns",
        "Columns",
        "Set the number of columns in new tables.",
        1,
        12,
        1,
      ),
    );
  }
  return items;
}

export interface ShapeSectionValueAdapter {
  readonly get: (key: SettingsControlKey) => unknown;
  readonly set: (key: SettingsControlKey, value: unknown) => Promise<void>;
}

export function shapeSections(values: ShapeSectionValueAdapter): SettingDefinitionRender[] {
  return [...CLOSED_SHAPE_TOOLS, ...OUTLINE_ONLY_TOOLS].map((tool) => {
    const name = sentenceCaseLabel(tool);
    const desc = `Configure defaults for new ${name.toLowerCase()} shapes.`;
    return {
      name,
      desc,
      render: (setting) => renderShapeSection(setting, name, desc, shapeItems(tool), values),
    };
  });
}

function renderShapeSection(
  setting: Setting,
  name: string,
  desc: string,
  definitions: SettingDefinition<SettingsControlKey>[],
  values: ShapeSectionValueAdapter,
): () => void {
  setting.settingEl.replaceChildren();
  const details = setting.settingEl.createEl("details", {
    cls: "inkbook-settings-shape-section",
  });
  details.createEl("summary", { text: name });
  details.createEl("p", { text: desc });

  const cleanups: Array<() => void> = [];
  for (const definition of definitions) {
    if (!("control" in definition) || definition.control === undefined) continue;
    const cleanup = renderShapeControl(details, definition, values);
    cleanups.push(cleanup);
  }
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

function renderShapeControl(
  container: HTMLElement,
  definition: SettingDefinition<SettingsControlKey> & {
    readonly control: NonNullable<SettingDefinition<SettingsControlKey>["control"]>;
  },
  values: ShapeSectionValueAdapter,
): () => void {
  const row = container.createDiv({ cls: "setting-item" });
  const info = row.createDiv({ cls: "setting-item-info" });
  const controlId = `inkbook-setting-${definition.control.key.replaceAll(".", "-")}`;
  const descriptionId = `${controlId}-description`;
  const errorId = `${controlId}-error`;
  const label = info.createEl("label", { cls: "setting-item-name", text: definition.name });
  label.htmlFor = controlId;
  const description = info.createDiv({ cls: "setting-item-description" });
  description.id = descriptionId;
  description.textContent = typeof definition.desc === "string" ? definition.desc : "";

  const controlContainer = row.createDiv({ cls: "setting-item-control" });
  const control = createShapeControl(
    controlContainer,
    definition.control,
    values.get(definition.control.key),
  );
  control.id = controlId;
  control.setAttribute("aria-describedby", `${descriptionId} ${errorId}`);
  const error = controlContainer.createDiv({ cls: "setting-item-description" });
  error.id = errorId;
  error.setAttribute("aria-live", "polite");
  error.hidden = true;

  const commit = (): void => {
    const value = definition.control.type === "slider" ? Number(control.value) : control.value;
    void values.set(definition.control.key, value).catch(() => {
      control.value = String(values.get(definition.control.key));
      error.textContent = "Enter a valid setting value.";
      error.hidden = false;
    });
  };
  control.addEventListener("change", commit);
  return () => control.removeEventListener("change", commit);
}

function createShapeControl(
  container: HTMLElement,
  definition: NonNullable<SettingDefinition<SettingsControlKey>["control"]>,
  value: unknown,
): HTMLInputElement | HTMLSelectElement {
  if (definition.type === "dropdown") {
    const select = container.createEl("select");
    for (const [optionValue, label] of Object.entries(definition.options)) {
      const option = select.createEl("option", { text: label });
      option.value = optionValue;
    }
    select.value = String(value);
    return select;
  }
  if (definition.type !== "slider") {
    throw new Error(`Unsupported shape setting control: ${definition.type}`);
  }
  const input = container.createEl("input");
  input.type = "range";
  input.min = String(definition.min);
  input.max = String(definition.max);
  input.step = String(definition.step);
  input.value = String(value);
  return input;
}

export function toolGroup(
  heading: string,
  items: SettingDefinition<SettingsControlKey>[],
  reset: () => void,
): SettingDefinitionGroup<SettingsControlKey> {
  return {
    type: "group",
    heading,
    items: [
      ...items,
      {
        name: "Reset group to defaults",
        desc: "Restore the built-in values without changing existing elements.",
        action: reset,
      },
    ],
  };
}
