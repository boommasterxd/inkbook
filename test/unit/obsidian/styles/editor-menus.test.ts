import { sys } from "typescript";
import { describe, expect, it } from "vitest";

const stylesheet = [
  readStylesheet("src/obsidian/styles/adaptive-panel.css"),
  readStylesheet("src/obsidian/styles/phone-sheet-host.css"),
  readStylesheet("src/obsidian/styles/editor-menus.css"),
  readStylesheet("src/obsidian/styles/background-menu.css"),
].join("\n");

describe("AdaptivePanel styling boundary", () => {
  it("uses native Obsidian menu tokens on the owned surface", () => {
    const panel =
      declarationsFor(".inkbook-adaptive-panel,\n.inkbook-owned-menu") +
      declarationsFor(".inkbook-adaptive-panel");
    const scroll = declarationsFor(".inkbook-adaptive-panel-scroll");
    const back = declarationsFor(".inkbook-adaptive-panel-back");

    expect(panel).toContain("background: var(--menu-background)");
    expect(panel).toContain("border: var(--menu-border-width) solid var(--menu-border-color)");
    expect(panel).toContain("border-radius: var(--menu-radius)");
    expect(panel).toContain("box-shadow: var(--menu-shadow)");
    expect(panel).toContain("backdrop-filter: var(--menu-backdrop-filter)");
    expect(panel).toContain("outline: none");
    expect(scroll).toContain("padding: var(--menu-padding)");
    expect(scroll).toContain("overflow: hidden");
    expect(scroll).toContain("overscroll-behavior: contain");
    expect(scroll).toContain("scrollbar-width: none");
    expect(back).toContain("outline: none");
    expect(scroll).toContain("var(--inkbook-motion-easing, cubic-bezier(0.2, 0, 0, 1))");
    expect(
      declarationsFor(
        '.inkbook-adaptive-panel-back:hover,\n.inkbook-adaptive-panel-layer:where([data-inkbook-keyboard-navigation="true"])\n  .inkbook-adaptive-panel-back:focus',
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

    expect(
      declarationsFor(".inkbook-phone-sheet-host .inkbook-phone-sheet-host-surface"),
    ).toContain("transition-property: none !important");
    expect(
      declarationsFor(
        '.inkbook-phone-sheet-host .inkbook-phone-sheet-host-surface[data-swipe-state="settling"]',
      ),
    ).toContain("transition-property: translate !important");
    expect(panel).toContain("max-block-size: var(--inkbook-adaptive-panel-maximum-height, 60%)");
    expect(panel).toContain("inline-size: auto");
    expect(panel).toContain("max-inline-size: none");
    expect(panel).toContain("border: none");
    expect(panel).toContain("border-radius: var(--touch-radius-s) var(--touch-radius-s) 0 0");
    expect(panel).toContain("position: absolute");
    expect(panel).toContain("touch-action: pan-down");
    expect(panel).toContain(
      "inset-inline: var(--safe-area-inset-left) var(--safe-area-inset-right)",
    );
    expect(scroll).toContain("var(--inkbook-adaptive-panel-maximum-height, 60vh) - 16px");
    expect(scroll).toContain("max(var(--safe-area-inset-bottom), var(--size-4-4))");
    expect(scroll).toContain("touch-action: pan-down");
    expect(grabber).toContain("background: var(--text-faint)");
    expect(grabber).toContain("inline-size: 15%");
    expect(grabber).toContain("margin: var(--size-4-2) auto var(--size-4-1)");
    expect(dragRegion).toContain("touch-action: none");
    expect(stylesheet).toContain('data-scroll-position="away"');
    expect(stylesheet).toContain('data-presence="entering"');
    expect(stylesheet).toContain('data-swipe-state="settling"');
    expect(stylesheet).not.toContain('data-state="open"] {\n  animation');
    expect(stylesheet).toContain("transition-duration: var(--inkbook-adaptive-panel-duration)");
    expect(stylesheet).toContain("transition-property: translate");
    expect(stylesheet).toContain("animation: inkbook-adaptive-panel-sheet-enter");
    expect(stylesheet).toContain("animation: inkbook-adaptive-panel-sheet-exit");
  });
});

describe("AdaptivePanel wide styling", () => {
  it("matches native static wide menus and mobile blur without card staggering", () => {
    const stylePanel = declarationsFor('.inkbook-adaptive-panel[data-kind="style"]');
    const mobilePanel = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-mobile="true"] .inkbook-adaptive-panel',
    );

    expect(stylePanel).toContain("inline-size: max-content");
    expect(stylePanel).toContain("max-inline-size: calc(100vw - 16px)");
    expect(stylesheet).not.toContain("inline-size: min(300px");
    expect(stylesheet).not.toContain("inline-size: min(340px");
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
    const cautionTitle = declarationsFor('.inkbook-menu-title-content[data-tone="caution"]');
    const choice = declarationsFor(
      ".inkbook-menu-controls .inkbook-menu-choice,\n.inkbook-menu-controls .inkbook-menu-stepper-button",
    );
    const pressedStepper = declarationsFor(
      ".inkbook-menu-choice:hover,\n.inkbook-menu-stepper-button:active,\n.inkbook-menu-stepper-button.inkbook-menu-stepper-button-pressed",
    );
    const releasedTouchStepper = declarationsFor(
      ".inkbook-menu-stepper-button-touch.mobile-tap:not(:active, .inkbook-menu-stepper-button-pressed)",
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
      '.inkbook-adaptive-panel-layer[data-platform="phone"]:where([data-kind="style"])\n  .inkbook-menu-control',
    );
    const wideSection = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="wide"] .inkbook-menu-control',
    );
    const wideFollowingSection = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="wide"] .inkbook-menu-control + .inkbook-menu-control',
    );
    const wideScroll = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="wide"]\n  [data-kind="style"]\n  .inkbook-adaptive-panel-scroll',
    );
    const wideWidthGrid = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="wide"] [data-kind="style"] .inkbook-menu-width-grid',
    );
    expect(choice).toContain("min-block-size: 36px");
    expect(cautionTitle).toContain("color: var(--color-orange)");
    expect(choice).toContain("min-inline-size: 36px");
    expect(stylesheet).toContain(
      ".inkbook-menu-stepper-button {\n  touch-action: manipulation;\n  -webkit-tap-highlight-color: transparent;",
    );
    expect(pressedStepper).toContain("background: var(--background-modifier-hover)");
    expect(releasedTouchStepper).toContain("background: var(--background-primary)");
    expect(stylesheet).toContain(
      "@media (hover: hover) and (pointer: fine) {\n  .inkbook-menu-stepper-button:not(.inkbook-menu-stepper-button-touch):hover",
    );
    expect(phoneChoice).toContain("min-block-size: 44px");
    expect(section).toContain("background: transparent");
    expect(section).toContain("border-radius: 0");
    expect(divider).toContain("border-block-start:");
    expect(divider).toContain("margin-inline: calc(var(--menu-padding) * -1)");
    expect(divider).toContain("padding-inline: calc(var(--menu-padding) + var(--size-4-1))");
    expect(phoneSection).toContain("background: var(--interactive-normal)");
    expect(phoneSection).toContain("border-radius: var(--touch-radius-xxs)");
    expect(wideSection).toContain("padding-inline: var(--size-4-2)");
    expect(wideFollowingSection).toContain(
      "padding-inline: calc(var(--menu-padding) + var(--size-4-2))",
    );
    expect(wideScroll).toContain("padding-block: 0");
    expect(wideWidthGrid).toContain("grid-template-columns: repeat(5, 36px)");
    expect(wideWidthGrid).toContain("justify-content: space-between");
    expect(valueField).toContain("display: flex");
    expect(valueField).toContain("justify-content: center");
    expect(value).toContain("inline-size: var(--inkbook-menu-value-width)");
    expect(value).toContain("background: transparent");
    expect(suffix).toContain("line-height: normal");
  });
});

describe("AdaptivePanel choice content styles", () => {
  it("centers width previews and labels as one natural-height content block", () => {
    const choice = declarationsFor(
      ".inkbook-menu-controls .inkbook-menu-choice,\n.inkbook-menu-controls .inkbook-menu-stepper-button",
    );
    const widthChoice = declarationsFor(".inkbook-menu-width-choice");
    const wideWidthChoice = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="wide"] [data-kind="style"] .inkbook-menu-width-choice',
    );
    const wideWidthPreview = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="wide"]\n  [data-kind="style"]\n  :where(.inkbook-menu-width-choice)\n  .inkbook-menu-line-preview',
    );

    expect(choice).toContain("align-items: center");
    expect(choice).toContain("justify-content: center");
    expect(widthChoice).toContain("flex-direction: column");
    expect(wideWidthChoice).toContain("gap: 3px");
    expect(wideWidthChoice).not.toContain("display: grid");
    expect(wideWidthChoice).not.toContain("grid-template-rows");
    expect(wideWidthPreview).toContain("inline-size: 22px");
    expect(wideWidthPreview).toContain("flex: 0 0 auto");
  });

  it("groups phone Background choices with native divider and interaction tokens", () => {
    const choice = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="phone"]:where([data-kind="background"])\n  .inkbook-menu-background-options\n  .inkbook-menu-background-choice',
    );
    const divider = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="phone"]:where([data-kind="background"])\n  .inkbook-menu-background-choice:not(:last-child)::after',
    );
    const spacing = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="phone"]:where([data-kind="background"])\n  .inkbook-menu-background-spacing:not(:empty)',
    );

    expect(choice).toContain("background: var(--interactive-normal)");
    expect(choice).toContain("font-size: var(--font-ui-medium)");
    expect(choice).toContain("padding: var(--size-4-3) var(--size-4-4)");
    expect(divider).toContain("background-color: var(--menu-divider-color)");
    expect(divider).toContain("block-size: var(--menu-divider-width)");
    expect(spacing).toContain("border-radius: var(--touch-radius-xxs)");
  });
});

describe("AdaptivePanel Background content styles", () => {
  it("lets the wide Background separator use the full panel content width", () => {
    const scroll = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="wide"]\n    .inkbook-adaptive-panel[data-kind="background"]\n    .inkbook-adaptive-panel-scroll',
    );
    const choices = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="wide"] .inkbook-menu-background-choices',
    );
    const choice = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="wide"] .inkbook-menu-background-choice,\n.inkbook-adaptive-panel-layer[data-platform="wide"] .inkbook-adaptive-panel-back',
    );
    const separator = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="wide"] .inkbook-menu-background-separator',
    );
    const back = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="wide"]\n  .inkbook-adaptive-panel\n  .inkbook-adaptive-panel-back',
    );
    const wideSpacing = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="wide"] .inkbook-menu-spacing-control',
    );
    const wideOutput = declarationsFor(
      '.inkbook-adaptive-panel-layer[data-platform="wide"] .inkbook-menu-spacing-output',
    );

    expect(scroll).toContain("padding-inline: 0");
    expect(scroll).toContain("scrollbar-gutter: auto");
    expect(choices).toContain("margin-inline: var(--menu-padding)");
    expect(choice).toContain("line-height: var(--line-height-tight)");
    expect(separator).toContain("margin-inline: 0");
    expect(back).toContain("block-size: auto");
    expect(back).toContain("padding: var(--size-4-1) var(--size-4-2)");
    expect(wideSpacing).toContain("padding-inline: calc(var(--menu-padding) + var(--size-4-2))");
    expect(wideOutput).toContain("block-size: var(--icon-s)");
    expect(wideOutput).toContain("display: inline-flex");
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
