import type { PointV1 } from "../../domain/schema/public";
import { menuDomWindow } from "./menu-dom";

export interface GeometryMenuContentOptions {
  readonly ownerDocument: Document;
  readonly operations: readonly { readonly value: number; readonly label: string }[];
  readonly onOperation: (index: number) => void;
  readonly onStep: (index: number, delta: PointV1) => void;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
}

/** Native controls inside the shared adaptive panel, usable with taps or a keyboard. */
export function createGeometryMenuContent(options: GeometryMenuContentOptions) {
  const fragment = menuDomWindow(options.ownerDocument, "geometry menu").createFragment();
  const root = fragment.createDiv({ cls: "inkbook-menu-controls inkbook-menu-geometry" });
  const field = root.createEl("label", { cls: "inkbook-menu-control" });
  field.createSpan({ cls: "inkbook-menu-control-header", text: "Operation" });
  const operation = field.createEl("select", { cls: "dropdown" });
  operation.setAttribute("aria-label", "Geometry operation");
  for (const choice of options.operations) {
    const option = operation.createEl("option", { text: choice.label });
    option.value = String(choice.value);
  }
  const step = root.createEl("section", { cls: "inkbook-menu-control" });
  step.setAttribute("role", "group");
  step.setAttribute("aria-label", "Step size");
  step.createSpan({ cls: "inkbook-menu-control-header", text: "Step size" });
  const sizes = step.createDiv({ cls: "inkbook-menu-choice-grid" });
  let amount = 1;
  for (const value of [1, 10]) {
    const button = sizes.createEl("button", { cls: "inkbook-menu-choice", text: String(value) });
    button.type = "button";
    button.setAttribute(
      "aria-label",
      `${value} document ${value === 1 ? "unit" : "units"} or ${value === 1 ? "degree" : "degrees"}`,
    );
    button.setAttribute("aria-pressed", String(value === amount));
    button.addEventListener("click", () => {
      amount = value;
      for (const choice of sizes.querySelectorAll("button"))
        choice.setAttribute("aria-pressed", String(choice === button));
    });
  }
  const actions = root.createDiv({ cls: "inkbook-menu-control" });
  const directions = actions.createDiv({ cls: "inkbook-menu-choice-grid" });
  for (const [label, icon, x, y] of [
    ["Left", "arrow-left", -1, 0],
    ["Right", "arrow-right", 1, 0],
    ["Up", "arrow-up", 0, -1],
    ["Down", "arrow-down", 0, 1],
  ] as const) {
    const button = directions.createEl("button", { cls: "inkbook-menu-choice" });
    button.type = "button";
    button.setAttribute("aria-label", label);
    options.renderIcon(button.createSpan({ attr: { "aria-hidden": "true" } }), icon);
    button.addEventListener("click", () => {
      options.onStep(Number(operation.value), { x: x * amount, y: y * amount });
    });
  }
  root.createEl("p", {
    cls: "inkbook-menu-control-description",
    text: "Move and resize use document units; rotation uses degrees. Use the left or up action to decrease an angle and the right or down action to increase it. Each adjustment can be undone.",
  });
  const status = root.createEl("p", { cls: "inkbook-menu-control-description" });
  status.setAttribute("role", "status");
  status.setAttribute("aria-atomic", "true");
  operation.addEventListener("change", () => options.onOperation(Number(operation.value)));
  return { fragment, status, operation, directions };
}
