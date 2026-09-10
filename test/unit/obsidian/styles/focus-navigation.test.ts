import { sys } from "typescript";
import { describe, expect, it } from "vitest";

const stylesheet = sys.readFile(sys.resolvePath("src/obsidian/styles/focus-navigation.css"));

describe("explicit focus styling", () => {
  it("draws the navigation ring on the shell inside the available width", () => {
    expect(stylesheet).toContain('[data-inkbook-keyboard-navigation="true"]:has(');
    expect(stylesheet).toContain(".inkbook-locked-preview:focus");
    expect(stylesheet).toContain(".inkbook-canvas-input:focus");
    expect(stylesheet).toContain(
      "border: 2px solid var(--interactive-accent);\n  border-radius: var(--inkbook-shell-radius);",
    );
    expect(stylesheet).toContain("box-sizing: border-box");
    expect(stylesheet).toContain("inset: 0");
    expect(stylesheet).toContain("pointer-events: none");
    expect(stylesheet).toContain("position: absolute");
  });

  it("suppresses incidental focus only within lifecycle-owned Inkbook surfaces", () => {
    expect(stylesheet).toContain('.inkbook-root[data-inkbook-keyboard-navigation="false"] :focus');
    expect(stylesheet).toContain(
      '.inkbook-adaptive-panel-layer[data-inkbook-keyboard-navigation="false"] :focus',
    );
    expect(stylesheet).toContain("outline: none");
    expect(stylesheet).not.toMatch(/^\[data-/m);
  });
});
