import { sys } from "typescript";
import { describe, expect, it } from "vitest";

const motionStylesheet = readStylesheet("src/obsidian/styles/motion.css");
const toolbarStylesheet = readStylesheet("src/obsidian/styles/editor-toolbar.css");
const toolbarMotionStylesheet = readStylesheet("src/obsidian/styles/editor-toolbar-motion.css");

describe("Inkbook toolbar action confirmation styles", () => {
  it("animates successful Clipboard actions through a reduced-motion-safe check glyph", () => {
    expect(toolbarMotionStylesheet).toContain("animation: inkbook-toolbar-action-icon-default");
    expect(toolbarMotionStylesheet).toContain(
      "animation: inkbook-toolbar-action-icon-confirmation",
    );
    expect(motionStylesheet).toContain("@keyframes inkbook-toolbar-action-icon-default");
    expect(motionStylesheet).toContain("@keyframes inkbook-toolbar-action-icon-confirmation");
    expect(motionStylesheet).toContain(
      '.inkbook-root[data-inkbook-motion="reduced"]\n  .inkbook-toolbar-action-icon[data-confirmed="true"]',
    );
  });

  it("mirrors left-handed context controls without changing their dimensions", () => {
    expect(toolbarStylesheet).toMatch(
      /inkbook-toolbar-composition-left-handed[\s\S]*inkbook-toolbar-context-actions \{[^}]*direction: rtl;[^}]*left: auto;[^}]*right: calc/u,
    );
    expect(toolbarStylesheet).toMatch(
      /inkbook-toolbar-composition-scrollable\.inkbook-toolbar-composition-left-handed[\s\S]*inkbook-toolbar \{[^}]*order: 1;/u,
    );
  });
});

function readStylesheet(path: string): string {
  const source = sys.readFile(path);
  if (source === undefined) throw new Error(`Missing stylesheet: ${path}`);
  return source;
}
