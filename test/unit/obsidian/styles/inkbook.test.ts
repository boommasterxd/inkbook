import { sys } from "typescript";
import { describe, expect, it } from "vitest";

const stylesheet = [
  readStylesheet("src/obsidian/styles/inkbook.css"),
  readStylesheet("src/obsidian/styles/editor-toolbar.css"),
  readStylesheet("src/obsidian/styles/editor-flyouts.css"),
].join("\n");
const motionStylesheet = readStylesheet("src/obsidian/styles/motion.css");

describe("Inkbook host styles", () => {
  it("animates the active tool visual without resizing its button or icon", () => {
    const root = declarationsFor(".inkbook-root");
    const button = declarationsFor(".inkbook-root .inkbook-toolbar-button");
    const active = declarationsFor('.inkbook-root .inkbook-toolbar-button[aria-pressed="true"]');
    const activeVisual = declarationsFor(
      '.inkbook-root .inkbook-toolbar-button[aria-pressed="true"]::before',
    );
    const visual = declarationsFor(".inkbook-root .inkbook-toolbar-button::before");
    const disabled = declarationsFor(".inkbook-root .inkbook-toolbar-button:disabled");
    const icon = declarationsFor(
      ".inkbook-root .inkbook-toolbar-icon,\n.inkbook-root .inkbook-toolbar-icon svg",
    );

    expect(root).toContain("--inkbook-motion-fast: 120ms");
    expect(button).toContain("block-size: 44px");
    expect(button).toContain("inline-size: 44px");
    expect(button).toContain("border-radius: 50%");
    expect(button).not.toContain("transform:");
    expect(button).toContain("color var(--inkbook-motion-fast)");
    expect(active).toContain("color: var(--interactive-accent)");
    expect(activeVisual).toContain("var(--interactive-accent) 14%");
    expect(activeVisual).toContain("transform: scale(0.96)");
    expect(visual).toContain("transform var(--inkbook-motion-fast) var(--inkbook-motion-easing)");
    expect(visual).toContain("border-radius: inherit");
    expect(disabled).toContain("color: var(--text-faint)");
    expect(disabled).toContain("opacity: 0.48");
    expect(icon).toContain("block-size: 19px");
    expect(icon).toContain("inline-size: 19px");
  });

  it("uses standard motion for toolbar enter and locking exit", () => {
    const root = declarationsFor(".inkbook-root");
    const shell = declarationsFor(".inkbook-root .inkbook-toolbar-shell");
    const locking = declarationsFor(
      '.inkbook-root[data-inkbook-state="locking"] .inkbook-toolbar-shell',
    );

    expect(root).toContain("--inkbook-motion-standard: 180ms");
    expect(shell).toContain("animation: inkbook-toolbar-enter var(--inkbook-motion-standard)");
    expect(locking).toContain("animation-name: inkbook-toolbar-exit");
    expect(keyframeDeclarations("inkbook-toolbar-enter", "from")).toContain("opacity: 0");
    expect(keyframeDeclarations("inkbook-toolbar-enter", "from")).toContain(
      "transform: translateY(-4px)",
    );
    expect(keyframeDeclarations("inkbook-toolbar-exit", "to")).toContain("opacity: 0");
    expect(keyframeDeclarations("inkbook-toolbar-exit", "to")).toContain(
      "transform: translateY(-4px)",
    );
  });

  it("draws locked-preview keyboard focus entirely inside the stabilized owner width", () => {
    const focus = declarationsFor(".inkbook-root .inkbook-locked-preview:focus-visible");
    const preview = declarationsFor(".inkbook-root .inkbook-locked-preview");
    const image = declarationsFor(".inkbook-root .inkbook-locked-preview-media");
    const svg = declarationsFor(".inkbook-root .inkbook-locked-preview-svg");

    expect(focus).toContain("outline: 2px solid var(--interactive-accent)");
    expect(focus).toContain("outline-offset: -2px");
    expect(preview).toContain("inline-size: 100%");
    expect(preview).toContain("block-size: auto");
    expect(preview).toContain("overflow: clip");
    expect(image).toContain("aspect-ratio: var(--inkbook-preview-aspect-ratio)");
    expect(image).toContain("pointer-events: none");
    expect(svg).toContain("block-size: 100%");
    expect(svg).toContain("pointer-events: none");
  });
});

describe("Inkbook editor chrome styles", () => {
  it("overlays a zero-height sticky toolbar without moving the active background", () => {
    const activeRoot = declarationsFor(
      '.inkbook-root[data-inkbook-state="active"],\n.inkbook-root[data-inkbook-state="locking"]',
    );
    const background = declarationsFor(".inkbook-root .inkbook-background-container");
    const chromeHost = declarationsFor(".inkbook-root .inkbook-editor-chrome-host");
    const embedRoot = declarationsFor(".inkbook-root.inkbook-embed-root");
    const livePreviewRoot = declarationsFor(
      '.inkbook-root.inkbook-embed-root[contenteditable="false"][data-inkbook-scheme][data-inkbook-state]',
    );
    const editorChrome = declarationsFor(".inkbook-root .inkbook-editor-chrome");
    const shell = declarationsFor(".inkbook-root .inkbook-toolbar-shell");
    const fixedUnlockScene = declarationsFor(
      ".inkbook-root.inkbook-active-preparing .inkbook-background-container > .inkbook-scene,\n.inkbook-root.inkbook-active-transitioning .inkbook-background-container > .inkbook-scene",
    );
    const preparingBackground = declarationsFor(
      ".inkbook-root.inkbook-active-preparing .inkbook-background-container",
    );

    expect(activeRoot).toContain("z-index: var(--layer-popover)");
    expect(background).not.toContain("margin-block-start");
    expect(embedRoot).toContain("contain: none !important");
    expect(embedRoot).toContain("overflow: visible");
    expect(livePreviewRoot).toContain("contain: none !important");
    expect(editorChrome).not.toContain("padding-block-start");
    expect(chromeHost).toContain("position: sticky");
    expect(chromeHost).toContain("block-size: 0");
    expect(chromeHost).toContain("var(--inkbook-toolbar-overlay-block-size)");
    expect(chromeHost).toContain("var(--inkbook-toolbar-scrollport-padding)");
    expect(chromeHost).toContain("overflow: visible");
    expect(shell).toContain("position: absolute");
    expect(shell).toContain("translate: 0 -100%");
    expect(shell).toContain("block-size: var(--inkbook-toolbar-overlay-block-size)");
    expect(background).toContain("overflow: clip");
    expect(preparingBackground).toContain(
      "block-size: var(--inkbook-locked-container-block-size) !important",
    );
    expect(fixedUnlockScene).toContain(
      "block-size: calc(var(--inkbook-active-scene-block-size) - 2px)",
    );
    expect(fixedUnlockScene).toContain("inset-block-end: auto");
  });

  it("keeps the main toolbar centered while context actions sit beside it", () => {
    const root = declarationsFor(".inkbook-root");
    const darkRoot = declarationsFor('.inkbook-root[data-inkbook-scheme="dark"]');
    const preview = declarationsFor(".inkbook-root .inkbook-locked-preview");
    const background = declarationsFor(".inkbook-root .inkbook-background-container");
    const composition = declarationsFor(".inkbook-root .inkbook-toolbar-composition");
    const main = declarationsFor(".inkbook-root .inkbook-toolbar");
    const sharedSurface = declarationsFor(
      ".inkbook-root .inkbook-toolbar,\n.inkbook-root .inkbook-toolbar-context-button",
    );
    const scrollable = declarationsFor(".inkbook-root .inkbook-toolbar-scrollable");
    const context = declarationsFor(".inkbook-root .inkbook-toolbar-context-actions");
    const contextButton = declarationsFor(".inkbook-root .inkbook-toolbar-context-button");

    expect(composition).toContain("position: relative");
    expect(root).toContain("--inkbook-page-surface: #f6f6f6");
    expect(darkRoot).toContain("--inkbook-page-surface: #212121");
    expect(preview).toContain("background: var(--inkbook-page-surface)");
    expect(background).toContain("background: var(--inkbook-page-surface)");
    expect(composition).toContain("--inkbook-toolbar-surface: var(--inkbook-page-surface)");
    expect(main).toContain("margin-inline: auto");
    expect(composition).toContain("--inkbook-toolbar-context-corridor: 128px");
    expect(composition).toContain("block-size: 48px");
    expect(sharedSurface).toContain("block-size: 48px");
    expect(sharedSurface).toContain("box-sizing: border-box");
    expect(main).toContain("padding: 2px");
    expect(main).toContain("width: max-content");
    expect(scrollable).toContain(
      "width: max(48px, calc(100% - var(--inkbook-toolbar-context-corridor)))",
    );
    expect(context).toContain(
      "inset-inline-start: calc(50% + var(--inkbook-toolbar-main-half, 0px) + 8px)",
    );
    expect(context).toContain("inset-block-start: 8px");
    expect(context).toContain("background: transparent");
    expect(context).toContain("border: 0");
    expect(context).toContain("box-shadow: none");
    expect(context).toContain("position: absolute");
    expect(sharedSurface).toContain("border-radius: 999px");
    expect(sharedSurface).toContain("background: var(--inkbook-toolbar-surface)");
    expect(contextButton).toContain("inline-size: 48px");
    expect(
      declarationsFor('.inkbook-root .inkbook-toolbar-context-button[data-presence="entering"]'),
    ).toContain("animation-name: inkbook-toolbar-context-control-enter");
    expect(motionStylesheet).toContain("flex-basis: 48px");
    expect(motionStylesheet).toContain("@keyframes inkbook-toolbar-context-control-enter");
  });
});

describe("Inkbook editor handoff styles", () => {
  it("keeps an opaque presentation throughout the unlock handoff", () => {
    const editor = declarationsFor(
      ".inkbook-root.inkbook-active-transitioning .inkbook-editor-chrome",
    );
    const preview = declarationsFor(
      ".inkbook-root.inkbook-active-transitioning .inkbook-preview-handoff",
    );

    expect(editor).toContain("opacity: 1");
    expect(editor).toContain("transition: none");
    expect(preview).toContain("opacity: 0");
    expect(preview).toContain("calc(var(--inkbook-motion-layout) - var(--inkbook-motion-fast))");
  });
});

describe("Inkbook editor overlays", () => {
  it("anchors attached save recovery at the bottom center", () => {
    const recovery = declarationsFor(".inkbook-root .inkbook-recovery");

    expect(recovery).toContain("inset-block-end: 16px");
    expect(recovery).toContain("inset-block-start: auto");
    expect(recovery).toContain("inset-inline-start: 50%");
    expect(recovery).toContain("translate: -50% 0");
  });

  it("uses icon-only controls for retry actions in host notices", () => {
    const button = declarationsFor(".inkbook-root .inkbook-notice-icon-button");
    const icon = declarationsFor(
      ".inkbook-root .inkbook-notice-action-icon,\n.inkbook-root .inkbook-notice-action-icon svg",
    );

    expect(button).toContain("border-radius: 50%");
    expect(button).toContain("inline-size: 36px");
    expect(button).toContain("min-block-size: 36px");
    expect(icon).toContain("block-size: 18px");
    expect(icon).toContain("inline-size: 18px");
  });

  it("keeps the background submenu beside the anchored overflow menu", () => {
    const menu = declarationsFor('.inkbook-root .inkbook-flyout[role="menu"]');
    const submenu = declarationsFor(
      ".inkbook-root .inkbook-overflow-background-region > div.inkbook-overflow-submenu",
    );

    expect(menu).toContain("overflow: visible");
    expect(submenu).toContain("inset-inline-end: calc(100% + 8px)");
    expect(submenu).toContain("position: absolute");
  });

  it("reduces toolbar and active-state motion to zero", () => {
    const reduced = declarationsFor('.inkbook-root[data-inkbook-motion="reduced"]');
    const media = blockFor("@media (prefers-reduced-motion: reduce)", motionStylesheet);

    expect(reduced).toContain("--inkbook-motion-fast: 0ms");
    expect(reduced).toContain("--inkbook-motion-standard: 0ms");
    expect(media).toContain("--inkbook-motion-fast: 0ms");
    expect(media).toContain("--inkbook-motion-standard: 0ms");
  });

  it("leaves the scrollbar lease as the only global Inkbook selector", () => {
    const selectors = topLevelSelectors(stylesheet);

    expect(selectors.filter((selector) => !selector.startsWith(".inkbook-root"))).toEqual([
      ".inkbook-scrollbar-stable",
    ]);
  });
});

function declarationsFor(selector: string): string {
  return blockFor(selector, stylesheet);
}

function keyframeDeclarations(name: string, stage: "from" | "to"): string {
  return blockFor(stage, blockFor(`@keyframes ${name}`, motionStylesheet));
}

function blockFor(header: string, source: string): string {
  const start = source.indexOf(`${header} {`);
  if (start < 0) throw new Error(`Missing CSS block: ${header}`);
  const opening = source.indexOf("{", start);
  let depth = 1;
  for (let cursor = opening + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "{") depth += 1;
    if (source[cursor] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(opening + 1, cursor);
  }
  throw new Error(`Unclosed CSS block: ${header}`);
}

function readStylesheet(path: string): string {
  const content = sys.readFile(sys.resolvePath(path));
  if (content === undefined) throw new Error("Unable to read the Inkbook stylesheet.");
  return content;
}

function topLevelSelectors(css: string): readonly string[] {
  const selectors: string[] = [];
  let cursor = 0;
  let depth = 0;
  while (cursor < css.length) {
    const opening = css.indexOf("{", cursor);
    if (opening < 0) break;
    const closing = css.indexOf("}", cursor);
    if (closing >= 0 && closing < opening) {
      depth = Math.max(0, depth - 1);
      cursor = closing + 1;
      continue;
    }
    if (depth === 0) {
      const boundary = Math.max(css.lastIndexOf("}", opening), css.lastIndexOf(";", opening));
      const selector = css.slice(boundary + 1, opening).trim();
      if (selector.startsWith("."))
        selectors.push(...selector.split(",").map((part) => part.trim()));
    }
    depth += 1;
    cursor = opening + 1;
  }
  return selectors;
}
