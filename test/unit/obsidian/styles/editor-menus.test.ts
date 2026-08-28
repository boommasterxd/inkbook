import { sys } from "typescript";
import { describe, expect, it } from "vitest";

const stylesheet = [
  readStylesheet("src/obsidian/styles/adaptive-panel.css"),
  readStylesheet("src/obsidian/styles/editor-menus.css"),
  readStylesheet("src/obsidian/styles/background-menu.css"),
].join("\n");

describe("AdaptivePanel styling boundary", () => {
  it("uses native Obsidian menu tokens on the owned surface", () => {
    const panel = declarationsFor(".inkbook-adaptive-panel");
    const scroll = declarationsFor(".inkbook-adaptive-panel-scroll");
    const back = declarationsFor(".inkbook-adaptive-panel-back");

    expect(panel).toContain("background: var(--menu-background)");
    expect(panel).toContain("border: var(--menu-border-width) solid var(--menu-border-color)");
    expect(panel).toContain("border-radius: var(--menu-radius)");
    expect(panel).toContain("box-shadow: var(--menu-shadow)");
    expect(panel).toContain("backdrop-filter: var(--menu-backdrop-filter)");
    expect(scroll).toContain("padding: var(--menu-padding)");
    expect(scroll).toContain("overflow: hidden");
    expect(scroll).toContain("overscroll-behavior: contain");
    expect(scroll).toContain("scrollbar-width: none");
    expect(back).toContain("outline: none");
    expect(scroll).toContain("var(--inkbook-motion-easing, cubic-bezier(0.2, 0, 0, 1))");
    expect(
      declarationsFor(
        ".inkbook-adaptive-panel-back:hover,\n.inkbook-adaptive-panel-back:focus-visible",
      ),
    ).toContain("box-shadow: none");
    expect(
      declarationsFor('.inkbook-adaptive-panel[data-state="open"] .inkbook-adaptive-panel-scroll'),
    ).toContain("overflow-y: auto");
  });

  it("never selects or modifies native menu surfaces", () => {
    const selectorHeaders = [...stylesheet.matchAll(/(?:^|\n)([^@\n][^{]+)\s*\{/gu)].map(
      (match) => match[1]?.trim() ?? "",
    );

    expect(
      selectorHeaders.some((selector) => /(^|[\s,>])\.menu(?:[\s.:#>,]|$)/u.test(selector)),
    ).toBe(false);
    expect(selectorHeaders.some((selector) => selector.includes(".menu-scroll"))).toBe(false);
    expect(stylesheet).not.toContain("inkbook-menu-motion");
    expect(stylesheet).not.toContain("inkbook-menu-phone");
    expect(stylesheet).not.toContain("inkbook-menu-wide");
  });

  it("uses a keyboard-aware, safe-area-aware phone bottom sheet", () => {
    const panel = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="phone"] .inkbook-adaptive-panel',
    );
    const scroll = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="phone"] .inkbook-adaptive-panel-scroll',
    );
    const grabber = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="phone"] .inkbook-adaptive-panel-grabber',
    );
    const dragRegion = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="phone"] .inkbook-adaptive-panel-drag-region',
    );

    expect(panel).toContain("max-block-size: 60%");
    expect(panel).toContain("inline-size: auto");
    expect(panel).toContain("border: none");
    expect(panel).toContain("border-radius: var(--touch-radius-s) var(--touch-radius-s) 0 0");
    expect(panel).toContain("position: absolute");
    expect(panel).toContain(
      "inset-inline: var(--safe-area-inset-left) var(--safe-area-inset-right)",
    );
    expect(scroll).toContain("var(--inkbook-adaptive-panel-viewport-height, 100vh) * 0.6");
    expect(scroll).toContain("var(--safe-area-inset-bottom)");
    expect(grabber).toContain("background: var(--text-faint)");
    expect(grabber).toContain("inline-size: 15%");
    expect(grabber).toContain("margin: var(--size-4-2) auto var(--size-4-1)");
    expect(dragRegion).toContain("touch-action: none");
    expect(stylesheet).toContain("animation: inkbook-adaptive-panel-sheet-enter");
    expect(stylesheet).toContain("animation: inkbook-adaptive-panel-sheet-exit");
  });

  it("matches native static wide menus and mobile blur without card staggering", () => {
    const mobilePanel = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-mobile="true"] .inkbook-adaptive-panel',
    );
    expect(mobilePanel).toContain("var(--blur-opacity-m)");
    expect(mobilePanel).toContain("border: none");
    expect(stylesheet).not.toContain("inkbook-adaptive-panel-enter");
    expect(stylesheet).not.toContain("inkbook-adaptive-panel-card-enter");
    expect(stylesheet).not.toContain("--inkbook-adaptive-panel-card-index");
    expect(stylesheet).toContain("@media (prefers-reduced-motion: reduce)");
    expect(stylesheet).toContain("animation: none !important");
  });
});

describe("AdaptivePanel content styles", () => {
  it("keeps Style controls touch-operable and synchronized fields visually unified", () => {
    const choice = declarationsFor(
      ".inkbook-menu-controls .inkbook-menu-choice,\n.inkbook-menu-controls .inkbook-menu-stepper-button",
    );
    const valueField = declarationsFor(".inkbook-menu-value-field");
    const value = declarationsFor(
      ".inkbook-menu-controls .inkbook-menu-value-field .inkbook-menu-value",
    );
    const suffix = declarationsFor(".inkbook-menu-value-suffix");

    const phoneChoice = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="phone"] .inkbook-menu-controls .inkbook-menu-choice,\n.inkbook-adaptive-panel-layer[data-platform="phone"]\n  .inkbook-menu-controls\n  .inkbook-menu-stepper-button',
    );
    const section = declarationsFor(".inkbook-menu-control");
    const divider = declarationsFor(".inkbook-menu-control + .inkbook-menu-control");
    const phoneSection = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="phone"] .inkbook-menu-control',
    );
    const desktopSection = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="wide"][data-mobile="false"] .inkbook-menu-control',
    );
    const desktopFollowingSection = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="wide"][data-mobile="false"]\n  .inkbook-menu-control\n  + .inkbook-menu-control',
    );

    expect(choice).toContain("min-block-size: 36px");
    expect(choice).toContain("min-inline-size: 36px");
    expect(phoneChoice).toContain("min-block-size: 44px");
    expect(section).toContain("background: transparent");
    expect(section).toContain("border-radius: 0");
    expect(divider).toContain("border-block-start:");
    expect(divider).toContain("margin-inline: calc(var(--menu-padding) * -1)");
    expect(divider).toContain("padding-inline: calc(var(--menu-padding) + var(--size-4-1))");
    expect(phoneSection).toContain("background: var(--interactive-normal)");
    expect(phoneSection).toContain("border-radius: var(--touch-radius-xxs)");
    expect(desktopSection).toContain("padding-inline: var(--size-4-2)");
    expect(desktopFollowingSection).toContain(
      "padding-inline: calc(var(--menu-padding) + var(--size-4-2))",
    );
    expect(valueField).toContain("display: flex");
    expect(valueField).toContain("justify-content: center");
    expect(value).toContain("inline-size: var(--inkbook-menu-value-width)");
    expect(value).toContain("background: transparent");
    expect(suffix).toContain("line-height: normal");
  });

  it("groups phone Background choices with native divider and interaction tokens", () => {
    const choice = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="phone"]\n  .inkbook-menu-background-options\n  .inkbook-menu-background-choice',
    );
    const divider = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="phone"]\n  .inkbook-menu-background-choice:not(:last-child)::after',
    );
    const spacing = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="phone"] .inkbook-menu-background-spacing:not(:empty)',
    );

    expect(choice).toContain("background: var(--interactive-normal)");
    expect(choice).toContain("font-size: var(--font-ui-medium)");
    expect(choice).toContain("padding: var(--size-4-3) var(--size-4-4)");
    expect(divider).toContain("background-color: var(--menu-divider-color)");
    expect(divider).toContain("block-size: var(--menu-divider-width)");
    expect(spacing).toContain("border-radius: var(--touch-radius-xxs)");
  });

  it("lets the wide Background separator use the full panel content width", () => {
    const scroll = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="wide"]\n    .inkbook-adaptive-panel[data-kind="background"]\n    .inkbook-adaptive-panel-scroll',
    );
    const choices = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="wide"] .inkbook-menu-background-choices',
    );
    const separator = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="wide"] .inkbook-menu-background-separator',
    );
    const back = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="wide"]\n  .inkbook-adaptive-panel\n  .inkbook-adaptive-panel-back',
    );

    expect(scroll).toContain("padding-inline: 0");
    expect(scroll).toContain("scrollbar-gutter: auto");
    expect(choices).toContain("margin-inline: var(--menu-padding)");
    expect(separator).toContain("margin-inline: 0");
    expect(back).toContain("block-size: auto");
    expect(back).toContain("padding: var(--size-4-1) var(--size-4-2)");
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

function readStylesheet(path: string): string {
  const content = sys.readFile(sys.resolvePath(path));
  if (content === undefined) throw new Error(`Unable to read ${path}.`);
  return content;
}
