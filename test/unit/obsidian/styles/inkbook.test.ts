import { sys } from "typescript";
import { describe, expect, it } from "vitest";

const stylesheet = readStylesheet("src/obsidian/styles/inkbook.css");
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
    const icon = declarationsFor(
      ".inkbook-root .inkbook-toolbar-icon,\n.inkbook-root .inkbook-toolbar-icon svg",
    );

    expect(root).toContain("--inkbook-motion-fast: 120ms");
    expect(button).toContain("block-size: 44px");
    expect(button).toContain("inline-size: 44px");
    expect(button).not.toContain("transform:");
    expect(button).toContain("color var(--inkbook-motion-fast)");
    expect(active).toContain("color: var(--text-on-accent)");
    expect(activeVisual).toContain("background: var(--interactive-accent)");
    expect(activeVisual).toContain("transform: scale(0.96)");
    expect(visual).toContain("transform var(--inkbook-motion-fast) var(--inkbook-motion-easing)");
    expect(icon).toContain("block-size: 20px");
    expect(icon).toContain("inline-size: 20px");
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

    expect(focus).toContain("outline: 2px solid var(--interactive-accent)");
    expect(focus).toContain("outline-offset: -2px");
  });

  it("uses the same 22-pixel leading shift covered by the left-handed width threshold", () => {
    const tools = declarationsFor(
      ".inkbook-root .inkbook-toolbar-wide.inkbook-toolbar-left-handed .inkbook-toolbar-tools",
    );

    expect(tools).toContain("translate: -22px 0");
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
