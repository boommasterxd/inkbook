import { sys } from "typescript";
import { describe, expect, it } from "vitest";

const stylesheet = sys.readFile(sys.resolvePath("src/obsidian/styles/settings.css"));
if (stylesheet === undefined) throw new Error("Unable to read the settings stylesheet.");

describe("settings styles", () => {
  it("centers toggle and dropdown controls against their complete text block", () => {
    expect(stylesheet).toContain(".setting-item.mod-toggle > .setting-item-control");
    expect(stylesheet).toContain(".setting-item > .setting-item-control:has(> .dropdown)");
    expect(stylesheet).toContain("align-self: center");
  });

  it("stretches the five width choices across the available settings width", () => {
    expect(stylesheet).toContain(`.inkbook-settings-tool-controls .inkbook-menu-width-grid {
  grid-template-columns: repeat(5, minmax(var(--inkbook-settings-width-choice-min), 1fr));
}`);
  });
});
