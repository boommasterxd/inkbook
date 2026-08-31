import { sys } from "typescript";
import { describe, expect, it } from "vitest";

const stylesheet = sys.readFile("src/obsidian/styles/inkbook.css") ?? "";

describe("selection overlay styles", () => {
  it("keeps every selection handle opaque above transparent outlines", () => {
    const match = /\.inkbook-selection-handles\s*\{(?<declarations>[^}]*)\}/u.exec(stylesheet);
    const declarations = match?.groups?.declarations ?? "";

    expect(declarations).toContain("fill: var(--interactive-accent)");
    expect(declarations).toContain("stroke: var(--interactive-accent)");
    expect(declarations).not.toContain("transparent");
  });
});
