import { sys } from "typescript";
import { describe, expect, it } from "vitest";

const stylesheet = [
  readStylesheet("src/obsidian/styles/inkbook.css"),
  readStylesheet("src/obsidian/styles/feedback.css"),
  readStylesheet("src/obsidian/styles/focus-navigation.css"),
  readStylesheet("src/obsidian/styles/editor-toolbar.css"),
  readStylesheet("src/obsidian/styles/editor-menus.css"),
  readStylesheet("src/obsidian/styles/background-menu.css"),
  readStylesheet("src/obsidian/styles/adaptive-panel.css"),
].join("\n");
const motionStylesheet = readStylesheet("src/obsidian/styles/motion.css");
const toolbarMotionStylesheet = readStylesheet("src/obsidian/styles/editor-toolbar-motion.css");

describe("Inkbook host styles", () => {
  it("anchors feedback outside note layout without intercepting the window", () => {
    const host = declarationsFor(".inkbook-root.inkbook-feedback-host");
    expect(host).toContain("position: fixed");
    expect(host).toContain("pointer-events: none");
    expect(host).toContain("align-items: flex-end");
  });

  it("centers delayed operation feedback in the visible embed without changing layout", () => {
    const feedback = declarationsFor(".inkbook-root .inkbook-operation-feedback");
    const icon = declarationsFor(".inkbook-root .inkbook-operation-feedback-icon");
    const reducedMotion = blockFor(
      '.inkbook-root:not([data-inkbook-motion="full"]) .inkbook-operation-feedback-icon',
      motionStylesheet,
    );

    expect(feedback).toContain("position: absolute");
    expect(feedback).toContain("translate: -50% -50%");
    expect(feedback).not.toContain("inset-block-start: 50%");
    expect(feedback).toContain("pointer-events: none");
    expect(icon).toContain("animation: inkbook-operation-spin 800ms linear infinite");
    expect(reducedMotion).toContain("animation: none");
  });

  it("animates the active tool visual without resizing its button or icon", () => {
    const root = declarationsFor(".inkbook-root");
    const button = declarationsFor(".inkbook-root .inkbook-toolbar-button");
    const active = declarationsFor('.inkbook-root .inkbook-toolbar-button[aria-pressed="true"]');
    const activeVisual = declarationsFor(
      '.inkbook-root .inkbook-toolbar-button[aria-pressed="true"]::before',
    );
    const activeToolVisual = declarationsFor(
      '.inkbook-root .inkbook-toolbar-button[data-inkbook-tool="true"][aria-pressed="true"]::before',
    );
    const indicator = declarationsFor(".inkbook-root .inkbook-toolbar-active-indicator");
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
    expect(activeToolVisual).toContain("background: transparent");
    expect(activeToolVisual).toContain("border-color: transparent");
    expect(indicator).toContain("block-size: 36px");
    expect(indicator).toContain("inline-size: 36px");
    expect(indicator).toContain(
      "transform: translate3d(var(--inkbook-toolbar-active-offset, 0), 0, 0)",
    );
    expect(indicator).toContain("transition: transform var(--inkbook-motion-fast)");
    expect(visual).toContain("transform var(--inkbook-motion-fast) var(--inkbook-motion-easing)");
    expect(visual).toContain("border-radius: inherit");
    expect(disabled).toContain("color: var(--text-faint)");
    expect(disabled).toContain("opacity: 0.48");
    expect(icon).toContain("block-size: 19px");
    expect(icon).toContain("inline-size: 19px");
  });

  it("draws locked-preview keyboard focus entirely inside the stabilized owner width", () => {
    const focus = declarationsFor(".inkbook-root .inkbook-locked-preview:focus");
    const preview = declarationsFor(".inkbook-root.inkbook-embed-root .inkbook-locked-preview");
    const android = declarationsFor(".inkbook-root .inkbook-locked-preview-android");
    const image = declarationsFor(".inkbook-root .inkbook-locked-preview-media");
    const svg = declarationsFor(".inkbook-root .inkbook-locked-preview-svg");

    expect(focus).toContain("outline: none");
    expect(preview).toContain("inline-size: 100%");
    expect(preview).toContain("block-size: auto");
    expect(preview).toContain("padding: 0");
    expect(preview).toContain("border-radius: var(--inkbook-shell-radius)");
    expect(preview).toContain("box-shadow: none");
    expect(preview).toContain("overflow: clip");
    expect(preview).toContain("transform: none");
    expect(preview).toContain("transition: none");
    expect(preview).toContain("contain: layout paint");
    expect(android).toContain("-webkit-tap-highlight-color: transparent");
    expect(android).toContain("min-block-size: 0");
    expect(android).toContain("min-inline-size: 0");
    expect(image).toContain("aspect-ratio: var(--inkbook-preview-aspect-ratio)");
    expect(image).toContain("pointer-events: none");
    expect(svg).toContain("block-size: 100%");
    expect(svg).toContain("pointer-events: none");
  });
});

describe("Inkbook toolbar motion styles", () => {
  it("scales the complete primary pill without animating its individual buttons", () => {
    const root = declarationsFor(".inkbook-root");
    const toolbar = blockFor(
      ".inkbook-root .inkbook-toolbar-shell .inkbook-toolbar",
      toolbarMotionStylesheet,
    );
    const locking = blockFor(
      '.inkbook-root[data-inkbook-state="locking"] .inkbook-toolbar-shell .inkbook-toolbar',
      toolbarMotionStylesheet,
    );

    expect(root).toContain("--inkbook-motion-toolbar: 220ms");
    expect(root).not.toContain("--inkbook-motion-toolbar-button-delay");
    expect(toolbar).toContain("animation: inkbook-toolbar-enter var(--inkbook-motion-toolbar)");
    expect(locking).toContain("animation: inkbook-toolbar-exit var(--inkbook-motion-toolbar)");
    expect(toolbar).toContain("transform-origin: center");
    expect(toolbarMotionStylesheet).not.toContain("inkbook-toolbar-button-enter");
    expect(keyframeDeclarations("inkbook-toolbar-enter", "from")).toContain("scale: 0");
    expect(keyframeDeclarations("inkbook-toolbar-enter", "from")).not.toContain("opacity:");
    expect(keyframeDeclarations("inkbook-toolbar-exit", "to")).toContain("scale: 0");
    expect(keyframeDeclarations("inkbook-toolbar-exit", "to")).not.toContain("opacity:");
  });
});

describe("Inkbook editor chrome styles", () => {
  it("leaves native vertical touch panning enabled on the canvas input surface", () => {
    const inputSurface = declarationsFor(".inkbook-root .inkbook-canvas-input");

    expect(inputSurface).toContain("touch-action: pan-y");
    expect(inputSurface).not.toContain("touch-action: none");
  });

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
    const hiddenEditorChrome = declarationsFor(".inkbook-root .inkbook-editor-chrome[hidden]");
    const heldUnlockForeground = declarationsFor(
      ".inkbook-root.inkbook-active-preparing .inkbook-editor-chrome-host,\n.inkbook-root.inkbook-active-preparing .inkbook-canvas-input,\n.inkbook-root.inkbook-active-preparing .inkbook-scene-foreground",
    );
    const scene = declarationsFor(".inkbook-root .inkbook-scene");
    const transitioningScene = declarationsFor(
      ".inkbook-root .inkbook-background-container.inkbook-page-height-transitioning > .inkbook-scene",
    );
    const shell = declarationsFor(".inkbook-root .inkbook-toolbar-shell");
    const fixedUnlockScene = declarationsFor(
      ".inkbook-root.inkbook-active-preparing .inkbook-background-container > .inkbook-scene,\n.inkbook-root.inkbook-active-transitioning .inkbook-background-container > .inkbook-scene",
    );
    const preparingBackground = declarationsFor(
      ".inkbook-root.inkbook-active-preparing .inkbook-background-container",
    );
    const unlockTransitionBackground = declarationsFor(
      ".inkbook-root.inkbook-active-preparing .inkbook-background-container,\n.inkbook-root.inkbook-active-transitioning .inkbook-background-container",
    );
    const presentationShell = declarationsFor(".inkbook-root.inkbook-embed-root::before");
    expect(activeRoot).toContain("z-index: var(--layer-popover)");
    expect(background).not.toContain("margin-block-start");
    expect(embedRoot).toContain("contain: none !important");
    expect(embedRoot).toContain("overflow: visible");
    expect(livePreviewRoot).toContain("contain: none !important");
    expect(editorChrome).not.toContain("padding-block-start");
    expect(hiddenEditorChrome).toContain("display: none !important");
    expect(heldUnlockForeground).toContain("visibility: hidden");
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
    expect(unlockTransitionBackground).toContain(
      "transition: block-size var(--inkbook-motion-layout) var(--inkbook-motion-layout-easing)",
    );
    expect(unlockTransitionBackground).toContain("will-change: block-size");
    expect(fixedUnlockScene).toContain(
      "block-size: calc(var(--inkbook-active-scene-block-size) - 2px)",
    );
    expect(fixedUnlockScene).toContain("inset-block-end: auto");
    expect(scene).toContain("inset-block: 0 auto");
    expect(scene).toContain("transform-origin: top left");
    expect(transitioningScene).toContain("inset-block: 0 auto");
    expect(presentationShell).toContain("background: var(--inkbook-page-surface)");
    expect(presentationShell).toContain("border: 1px solid var(--background-modifier-border)");
    expect(presentationShell).toContain("pointer-events: none");
  });
});

describe("Inkbook responsive toolbar styles", () => {
  it("keeps the main toolbar centered while context actions sit beside it", () => {
    const root = declarationsFor(".inkbook-root");
    const darkRoot = declarationsFor('.inkbook-root[data-inkbook-scheme="dark"]');
    const preview = declarationsFor(".inkbook-root.inkbook-embed-root .inkbook-locked-preview");
    const background = declarationsFor(".inkbook-root .inkbook-background-container");
    const composition = declarationsFor(".inkbook-root .inkbook-toolbar-composition");
    const shell = declarationsFor(".inkbook-root .inkbook-toolbar-shell");
    const rail = declarationsFor(".inkbook-root .inkbook-toolbar-rail");
    const scrollableComposition = declarationsFor(
      ".inkbook-root .inkbook-toolbar-composition-scrollable",
    );
    const scrollableRail = declarationsFor(
      ".inkbook-root .inkbook-toolbar-composition-scrollable .inkbook-toolbar-rail",
    );
    const main = declarationsFor(".inkbook-root .inkbook-toolbar");
    const sharedSurface = declarationsFor(
      ".inkbook-root .inkbook-toolbar,\n.inkbook-root .inkbook-toolbar-context-button",
    );
    const scrollable = declarationsFor(".inkbook-root .inkbook-toolbar-scrollable");
    const context = declarationsFor(".inkbook-root .inkbook-toolbar-context-actions");
    const contextButton = declarationsFor(".inkbook-root .inkbook-toolbar-context-button");

    expect(composition).toContain("position: relative");
    expect(root).toContain("--inkbook-page-surface: #f6f6f6");
    expect(root).toContain("--inkbook-toolbar-overlay-block-size: 68px");
    expect(darkRoot).toContain("--inkbook-page-surface: #212121");
    expect(preview).toContain("background: transparent");
    expect(preview).toContain("border: 1px solid transparent");
    expect(background).toContain("background: transparent");
    expect(background).toContain("border: 1px solid transparent");
    expect(composition).toContain("--inkbook-toolbar-surface: var(--menu-background)");
    expect(main).toContain("margin-inline: auto");
    expect(composition).toContain("background: transparent");
    expect(composition).toContain("block-size: 50px");
    expect(composition).toContain("inset-block-start: 7px");
    expect(rail).toContain("block-size: 48px");
    expect(rail).toContain("inset-block-start: 1px");
    expect(rail).toContain("position: relative");
    expect(scrollableComposition).toContain("overflow: auto hidden");
    expect(scrollableComposition).toContain("border-radius: 999px");
    expect(scrollableComposition).toContain("scrollbar-width: none");
    expect(scrollableRail).toContain("display: flex");
    expect(scrollableRail).toContain("inline-size: max-content");
    expect(scrollableRail).toContain("gap: 8px");
    expect(shell).toContain(
      "filter: drop-shadow(0 8px 12px rgb(0 0 0 / 14%)) drop-shadow(0 1px 1px rgb(0 0 0 / 18%))",
    );
    expect(sharedSurface).toContain("block-size: 48px");
    expect(sharedSurface).toContain("box-sizing: border-box");
    expect(main).toContain("padding: 2px");
    expect(main).toContain("width: max-content");
    expect(scrollable).toContain("width: max-content");
    expect(scrollable).not.toContain("overflow-x: auto");
    expect(context).toContain(
      "inset-inline-start: calc(50% + var(--inkbook-toolbar-main-half, 0px) + 8px)",
    );
    expect(context).toContain("inset-block-start: 0");
    expect(context).toContain("background: transparent");
    expect(context).toContain("border: 0");
    expect(context).toContain("box-shadow: none");
    expect(context).toContain("position: absolute");
    expect(sharedSurface).toContain("border-radius: 999px");
    expect(sharedSurface).toContain("background: var(--inkbook-toolbar-surface)");
    expect(sharedSurface).toContain("border: 1px solid var(--menu-border-color)");
    expect(sharedSurface).toContain("box-shadow: none");
    expect(contextButton).toContain("inline-size: 48px");
  });
});

describe("Inkbook context toolbar motion styles", () => {
  it("scales context controls with staggered state changes and a bounded lock exit", () => {
    const root = declarationsFor(".inkbook-root");

    expect(
      blockFor(".inkbook-root .inkbook-toolbar-context-button", toolbarMotionStylesheet),
    ).toContain("animation: inkbook-toolbar-context-control-enter");
    expect(
      blockFor(
        '.inkbook-root .inkbook-toolbar-context-button[data-presence="entering"]',
        toolbarMotionStylesheet,
      ),
    ).toContain("var(--inkbook-motion-toolbar) ease-out");
    expect(
      blockFor(
        '.inkbook-root .inkbook-toolbar-context-button[data-presence="exiting"]',
        toolbarMotionStylesheet,
      ),
    ).toContain("var(--inkbook-motion-toolbar) ease-in");
    expect(
      blockFor(
        '.inkbook-root[data-inkbook-state="locking"] .inkbook-toolbar-context-button',
        toolbarMotionStylesheet,
      ),
    ).toContain("animation-delay: 0ms");
    expect(
      blockFor(
        '.inkbook-root .inkbook-toolbar-context-button[data-presence-order="1"]',
        toolbarMotionStylesheet,
      ),
    ).toContain("--inkbook-presence-delay: var(--inkbook-motion-toolbar-context-stagger)");
    expect(root).toContain("--inkbook-motion-toolbar-context-stagger: 50ms");
    expect(keyframeDeclarations("inkbook-toolbar-context-control-enter", "from")).not.toContain(
      "flex-basis:",
    );
    expect(keyframeDeclarations("inkbook-toolbar-context-control-enter", "to")).not.toContain(
      "flex-basis:",
    );
    expect(motionStylesheet).toContain("@keyframes inkbook-toolbar-context-control-enter");
  });
});

describe("Inkbook editor handoff styles", () => {
  it("keeps one persistent opaque shell while switching borderless presentations", () => {
    const shell = declarationsFor(".inkbook-root.inkbook-embed-root::before");
    const editor = declarationsFor(".inkbook-root .inkbook-editor-chrome");
    const handoff = declarationsFor(".inkbook-root .inkbook-preview-handoff");
    const hiddenHandoff = declarationsFor(".inkbook-root .inkbook-preview-handoff[hidden]");
    const preview = declarationsFor(
      ".inkbook-root.inkbook-embed-root.inkbook-active-transitioning .inkbook-preview-handoff,\n.inkbook-root.inkbook-embed-root.inkbook-active-preparing .inkbook-preview-handoff",
    );

    expect(shell).toContain("background: var(--inkbook-page-surface)");
    expect(shell).toContain("border: 1px solid var(--background-modifier-border)");
    expect(shell).toContain("box-shadow: var(--inkbook-surface-shadow)");
    expect(editor).not.toContain("opacity:");
    expect(handoff).not.toContain("display:");
    expect(hiddenHandoff).toContain("display: none !important");
    expect(preview).not.toContain("opacity:");
    expect(preview).toContain("position: absolute");
    expect(preview).toContain("z-index: 2");
  });

  it("clips once at the stable outer envelope during content-driven height motion", () => {
    const scene = declarationsFor(".inkbook-root .inkbook-scene");
    const transitioningScene = declarationsFor(
      ".inkbook-root .inkbook-background-container.inkbook-page-height-transitioning > .inkbook-scene",
    );

    expect(scene).toContain("contain: layout");
    expect(scene).toContain("overflow: visible");
    expect(transitioningScene).toContain(
      "block-size: calc(var(--inkbook-page-height-envelope-block-size) - 2px)",
    );
  });
});

describe("Inkbook editor overlays", () => {
  it("preserves the attached save recovery surface in the window host", () => {
    const recovery = declarationsFor(".inkbook-root .inkbook-feedback-presentation");

    expect(recovery).toContain("background: var(--inkbook-page-surface)");
    expect(recovery).toContain("pointer-events: auto");
  });

  it("uses accessible icon-only feedback controls with complete touch targets", () => {
    const actions = declarationsFor(".inkbook-root .inkbook-feedback-actions");
    const button = declarationsFor(".inkbook-root .inkbook-feedback-icon-button");
    const copy = declarationsFor(".inkbook-root .inkbook-feedback-copy");
    const iconContainer = declarationsFor(
      ".inkbook-root .inkbook-feedback-status-icon,\n.inkbook-root .inkbook-feedback-action-icon",
    );
    const icon = declarationsFor(
      ".inkbook-root .inkbook-feedback-status-icon,\n.inkbook-root .inkbook-feedback-status-icon svg,\n.inkbook-root .inkbook-feedback-action-icon,\n.inkbook-root .inkbook-feedback-action-icon svg",
    );

    expect(button).toContain("border-radius: 50%");
    expect(button).toContain("inline-size: 44px");
    expect(button).toContain("min-block-size: 44px");
    expect(copy).toContain("flex: 1 1 0");
    expect(actions).toContain("margin-inline-start: auto");
    expect(iconContainer).toContain("display: inline-flex");
    expect(iconContainer).toContain("line-height: 0");
    expect(icon).toContain("block-size: 18px");
    expect(icon).toContain("inline-size: 18px");
  });

  it("keeps owned Style controls compact and visually unified", () => {
    const controls = declarationsFor(".inkbook-menu-controls");
    const field = declarationsFor(".inkbook-menu-control");
    const choice = declarationsFor(
      ".inkbook-menu-controls .inkbook-menu-choice,\n.inkbook-menu-controls .inkbook-menu-stepper-button",
    );
    const spacing = declarationsFor(".inkbook-menu-spacing-control");
    const spacingSlider = declarationsFor(
      ".inkbook-menu-spacing-control .inkbook-menu-spacing-slider",
    );
    const styleSlider = declarationsFor(".inkbook-menu-slider-row > .inkbook-menu-slider");
    const widthPreview = declarationsFor(".inkbook-menu-width-choice .inkbook-menu-line-preview");
    expect(controls).toContain("inline-size: 100%");
    expect(controls).toContain("margin: 0");
    expect(controls).toContain("min-inline-size: 0");
    expect(controls).toContain("padding: 0");
    expect(field).toContain("background: transparent");
    expect(field).toContain("border-radius: 0");
    expect(choice).toContain("min-block-size: 36px");
    expect(choice).toContain("min-inline-size: 36px");
    expect(choice).toContain("border: 1px solid var(--background-modifier-border)");
    expect(choice).toContain("box-shadow: none");
    expect(spacing).toContain("inline-size: 100%");
    expect(spacing).toContain("margin: 0");
    expect(spacing).toContain("padding: 10px");
    expect(spacing).not.toContain("background:");
    expect(spacing).not.toContain("border:");
    expect(spacing).not.toContain("border-radius:");
    expect(spacingSlider).toContain("inline-size: 100%");
    expect(styleSlider).toContain("inline-size: 100%");
    expect(widthPreview).toContain("background: currentcolor");
    expect(widthPreview).toContain("border: 0");
    expect(widthPreview).toContain("border-radius: 999px");
  });

  it("reduces toolbar and active-state motion to zero", () => {
    const reduced = declarationsFor('.inkbook-root[data-inkbook-motion="reduced"]');
    const media = blockFor("@media (prefers-reduced-motion: reduce)", motionStylesheet);
    expect(reduced).toContain("--inkbook-motion-fast: 0ms");
    expect(reduced).toContain("--inkbook-motion-standard: 0ms");
    expect(media).toContain("--inkbook-motion-fast: 0ms");
    expect(media).toContain("--inkbook-motion-standard: 0ms");
  });

  it("limits global Inkbook selectors to exact scroll-owner lifecycle classes", () => {
    const selectors = topLevelSelectors(stylesheet);
    expect(
      selectors.filter(
        (selector) =>
          !selector.startsWith(".inkbook-root") &&
          !selector.startsWith(".inkbook-menu-") &&
          !selector.startsWith(".inkbook-adaptive-panel") &&
          selector !== ".inkbook-tool-cursor-surface" &&
          !selector.startsWith(".inkbook-tool-cursor-surface ") &&
          selector !== ".is-phone .inkbook-root.inkbook-feedback-host" &&
          selector !== ".inkbook-owned-menu",
      ),
    ).toEqual([".inkbook-scrollbar-stable", ".inkbook-scroll-anchor-suppressed"]);
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
