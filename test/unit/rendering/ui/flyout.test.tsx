import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BackgroundFlyout, ShapeFlyout, StyleFlyout } from "../../../../src/rendering/ui/flyout";

describe("editor chrome flyouts", () => {
  it("renders mutually exclusive background choices and relevant spacing", () => {
    const markup = renderToStaticMarkup(
      <BackgroundFlyout
        onSpacingChange={vi.fn()}
        onTypeChange={vi.fn()}
        state={{ spacing: "m", type: "lines" }}
      />,
    );
    expect(markup).toContain("Background type");
    expect(markup).toContain("Spacing");
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Lines/u);
    expect(markup).toMatch(/aria-pressed="true"[^>]*>M/u);

    const none = renderToStaticMarkup(
      <BackgroundFlyout
        onSpacingChange={vi.fn()}
        onTypeChange={vi.fn()}
        state={{ spacing: null, type: "none" }}
      />,
    );
    expect(none).not.toContain("Spacing");
  });

  it("renders every specified shape and marks the current shape", () => {
    const markup = renderToStaticMarkup(<ShapeFlyout onChange={vi.fn()} value="table" />);
    expect(markup).toContain("Coordinate system");
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Table/u);
    expect(markup.match(/<button/gu)).toHaveLength(10);
  });

  it("renders only caller-supplied context-sensitive style controls", () => {
    const markup = renderToStaticMarkup(
      <StyleFlyout
        controls={[
          {
            id: "width",
            kind: "choice",
            label: "Width",
            mixed: true,
            options: [
              { label: "S", value: "s" },
              { label: "M", value: "m" },
            ],
            value: null,
          },
          { checked: true, id: "pressure", kind: "toggle", label: "Pressure sensitivity" },
          { id: "columns", kind: "number", label: "Columns", max: 12, min: 1, step: 1, value: 3 },
        ]}
        onChange={vi.fn()}
      />,
    );
    expect(markup).toContain("Width, mixed");
    expect(markup).toContain("Pressure sensitivity");
    expect(markup).toContain('aria-label="Columns"');
  });
});
