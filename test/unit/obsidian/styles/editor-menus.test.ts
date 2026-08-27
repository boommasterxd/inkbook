import { sys } from "typescript";
import { describe, expect, it } from "vitest";

const stylesheet = readStylesheet();

describe("Inkbook menu styles", () => {
  it("keeps menu controls compact without adding a false white swatch ring", () => {
    const swatch = declarationsFor(".inkbook-menu-color-swatch");
    const toggle = declarationsFor(".inkbook-menu-toggle-row");
    const widths = declarationsFor(".inkbook-menu-width-grid");
    const spacing = declarationsFor(".inkbook-menu-spacing-control > .inkbook-menu-spacing-slider");
    const spacingLabels = declarationsFor(".inkbook-menu-spacing-labels");
    const spacingLabel = declarationsFor(".inkbook-menu-spacing-labels > span");
    expect(swatch).not.toContain("box-shadow:");
    expect(toggle).toContain("min-block-size: 44px");
    expect(toggle).toContain("justify-content: space-between");
    expect(widths).toContain("repeat(5, minmax(44px, 1fr))");
    expect(spacing).toContain("block-size: 44px");
    expect(spacing).toContain("background-clip: content-box");
    expect(spacing).toContain("padding-block: 20px");
    expect(spacingLabels).toContain("display: flex");
    expect(spacingLabels).toContain("justify-content: space-between");
    expect(spacingLabels).toContain("calc(var(--slider-thumb-width, 18px) / 2)");
    expect(spacingLabel).toContain("inline-size: 0");
    expect(spacingLabel).toContain("justify-content: center");
  });
});

function declarationsFor(selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing CSS block: ${selector}`);
  const opening = stylesheet.indexOf("{", start);
  const closing = stylesheet.indexOf("}", opening);
  if (closing < 0) throw new Error(`Unclosed CSS block: ${selector}`);
  return stylesheet.slice(opening + 1, closing);
}

function readStylesheet(): string {
  const content = sys.readFile(sys.resolvePath("src/obsidian/styles/editor-menus.css"));
  if (content === undefined) throw new Error("Unable to read the editor-menu stylesheet.");
  return content;
}
