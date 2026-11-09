import { Localization, type Translator } from "../../domain/localization";
import type { StyleControl } from "./editor-menu-types";

export interface StructuralStyleState {
  readonly coordinateDimension?: "2d" | "3d" | null;
  readonly tableColumns?: number | null;
}

export function createStructuralStyleControls(
  state: StructuralStyleState,
  t: Translator = new Localization().t,
): readonly StyleControl[] {
  const controls: StyleControl[] = [];
  if (state.coordinateDimension !== undefined) {
    controls.push({
      id: "coordinate-dimension",
      kind: "choice",
      label: t("editor.control.coordinate-dimension"),
      mixed: state.coordinateDimension === null,
      options: [
        { label: "2D", value: "2d" },
        { label: "3D", value: "3d" },
      ],
      value: state.coordinateDimension,
    });
  }
  if (state.tableColumns !== undefined) {
    controls.push({
      id: "table-columns",
      kind: "number",
      label: t("editor.control.table-columns"),
      max: 12,
      min: 1,
      mixed: state.tableColumns === null,
      step: 1,
      value: state.tableColumns,
    });
  }
  return controls;
}
