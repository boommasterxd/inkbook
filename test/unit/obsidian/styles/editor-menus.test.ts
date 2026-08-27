import { sys } from "typescript";
import { describe, expect, it } from "vitest";

const stylesheet = readStylesheet();

describe("Inkbook menu styles", () => {
  it("keeps menu controls compact without adding a false white swatch ring", () => {
    const swatch = declarationsFor(".inkbook-menu-color-swatch");
    const toggle = declarationsFor(".inkbook-menu-toggle-row");
    const widths = declarationsFor(".inkbook-menu-width-grid");
    const spacing = declarationsFor(".inkbook-menu-spacing-control .inkbook-menu-spacing-slider");
    const spacingRow = declarationsFor(".inkbook-menu-spacing-slider-row");
    const spacingLabels = declarationsFor(".inkbook-menu-spacing-labels");
    const spacingLabel = declarationsFor(".inkbook-menu-spacing-labels > span");
    const sliderRow = declarationsFor(".inkbook-menu-slider-row");
    const valueField = declarationsFor(".inkbook-menu-value-field");
    const valueContent = declarationsFor(".inkbook-menu-value-content");
    const value = declarationsFor(
      ".inkbook-menu-controls .inkbook-menu-value-field .inkbook-menu-value",
    );
    const suffix = declarationsFor(".inkbook-menu-value-suffix");
    expect(swatch).not.toContain("box-shadow:");
    expect(toggle).toContain("min-block-size: 44px");
    expect(toggle).toContain("justify-content: space-between");
    expect(widths).toContain("repeat(5, minmax(44px, 1fr))");
    expect(spacing).toContain("inline-size: 100%");
    expect(spacing).not.toContain("background-clip:");
    expect(spacing).not.toContain("padding-block:");
    expect(spacingRow).toContain("min-block-size: 28px");
    expect(spacingRow).toContain("align-items: center");
    expect(spacingLabels).toContain("position: relative");
    expect(spacingLabels).toContain("overflow: visible");
    expect(spacingLabels).toContain("calc(var(--slider-thumb-width, 18px) / 2)");
    expect(spacingLabel).toContain("inline-size: max-content");
    expect(spacingLabel).toContain("position: absolute");
    expect(spacingLabel).toContain("translate: -50% 0");
    expect(spacingLabel).toContain("white-space: nowrap");
    expect(declarationsFor(".inkbook-menu-spacing-labels > span:nth-child(4)")).toContain(
      "inset-inline-start: 100%",
    );
    expect(sliderRow).toContain("grid-template-columns: minmax(100px, 1fr) 70px");
    expect(valueField).toContain("display: flex");
    expect(valueField).toContain("justify-content: center");
    expect(valueField).toContain("inline-size: 70px");
    expect(valueField).toContain("background: var(--background-primary)");
    expect(valueField).toContain("border: 1px solid var(--background-modifier-border)");
    expect(valueContent).toContain("display: inline-flex");
    expect(valueContent).toContain("max-inline-size: 100%");
    expect(value).toContain("background: transparent");
    expect(value).toContain("border: 0");
    expect(value).toContain("box-shadow: none");
    expect(value).toContain("inline-size: var(--inkbook-menu-value-width)");
    expect(suffix).toContain("font-size: var(--font-ui-small)");
    expect(suffix).toContain("line-height: normal");
  });

  it("keeps touch sheets fluid and clears the host surface only for wide precise pointers", () => {
    const controls = declarationsFor(".inkbook-menu-controls");
    const mediaHeader = "@media (width > 600px) and (hover: hover) and (pointer: fine)";
    const mediaStart = stylesheet.indexOf(`${mediaHeader} {`);
    const desktop = stylesheet.slice(mediaStart);

    expect(controls).toContain("inline-size: calc(100% + 24px)");
    expect(mediaStart).toBeGreaterThanOrEqual(0);
    expect(desktop).toContain("inline-size: 351px");
    expect(desktop).toContain(`.menu.inkbook-menu-motion-cards {
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    overflow: visible;
  }`);
    expect(desktop).toContain(`.menu.inkbook-menu-motion-cards .menu-scroll {
    overflow: visible;
  }`);
    expect(desktop).toContain(`.menu.inkbook-menu-motion-cards .inkbook-menu-control {
    background: var(--background-secondary);
    box-shadow: var(--shadow-s);
  }`);
    expect(desktop).toContain("inkbook-toolbar-context-control-enter");
    expect(desktop).toContain("inkbook-toolbar-context-control-exit");
    expect(desktop).toContain("animation-delay: var(--inkbook-menu-card-delay, 0ms)");
    expect(desktop).toContain("animation-delay: var(--inkbook-menu-card-exit-delay, 0ms)");
    expect(desktop).toContain("animation: inkbook-menu-surface-morph");
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
