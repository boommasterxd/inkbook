import { describe, expect, it } from "vitest";

import { createStructuralStyleControls } from "../../../../src/obsidian/menus/structural-style-controls";

describe("structural style controls", () => {
  it("describes operable coordinate dimension and table column controls", () => {
    expect(createStructuralStyleControls({ coordinateDimension: "3d", tableColumns: 4 })).toEqual([
      {
        id: "coordinate-dimension",
        kind: "choice",
        label: "Dimensions",
        mixed: false,
        options: [
          { label: "2D", value: "2d" },
          { label: "3D", value: "3d" },
        ],
        value: "3d",
      },
      {
        id: "table-columns",
        kind: "number",
        label: "Columns",
        max: 12,
        min: 1,
        mixed: false,
        step: 1,
        value: 4,
      },
    ]);
  });

  it("represents mixed structural values and omits inapplicable controls", () => {
    expect(createStructuralStyleControls({})).toEqual([]);
    expect(
      createStructuralStyleControls({ coordinateDimension: null, tableColumns: null }),
    ).toMatchObject([
      { id: "coordinate-dimension", mixed: true, value: null },
      { id: "table-columns", mixed: true, value: null },
    ]);
  });
});
