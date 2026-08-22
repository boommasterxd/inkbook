import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StyleFlyout } from "../../../../src/rendering/ui/flyout";
import { createStructuralStyleControls } from "../../../../src/rendering/ui/structural-style-controls";

describe("structural style controls", () => {
  it("renders operable coordinate dimension and table column controls", () => {
    const markup = renderToStaticMarkup(
      <StyleFlyout
        controls={createStructuralStyleControls({ coordinateDimension: "3d", tableColumns: 4 })}
        onChange={vi.fn()}
      />,
    );

    expect(markup).toContain("Dimensions");
    expect(markup).toMatch(/aria-pressed="true"[^>]*>3D/u);
    expect(markup).toContain('aria-label="Columns"');
    expect(markup).toContain('max="12"');
    expect(markup).toContain('min="1"');
    expect(markup).toContain('value="4"');
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
