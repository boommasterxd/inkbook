import { sys } from "typescript";
import { describe, expect, it } from "vitest";

const stylesheet = sys.readFile("src/obsidian/styles/inkbook.css") ?? "";

describe("selection overlay styles", () => {
  it("doubles only the clipped frame stroke while retaining transparent selection fill", () => {
    const frame = /\.inkbook-selection-overlay\s*\{(?<declarations>[^}]*)\}/u.exec(stylesheet);
    expect(frame?.groups?.declarations).toContain("stroke-width: 3");
    const shared = /\.inkbook-scene-overlays path\s*\{(?<declarations>[^}]*)\}/u.exec(stylesheet);
    expect(shared?.groups?.declarations).toContain("stroke-width: 1.5");
    expect(shared?.groups?.declarations).toContain("18%, transparent");
  });

  it("supplies accent color to use instances and composites their inner edge once", () => {
    const halo = /\.inkbook-selection-halo\s*\{(?<declarations>[^}]*)\}/u.exec(stylesheet);
    expect(halo?.groups?.declarations).toContain("opacity: 0.6");
    expect(halo?.groups?.declarations).toContain("color: var(--interactive-accent)");
    const source = /\.inkbook-selection-halo-source\s*\{(?<declarations>[^}]*)\}/u.exec(stylesheet);
    expect(source?.groups?.declarations).toContain("color: var(--interactive-accent)");
    const center = /\.inkbook-selection-center-trace\s*\{(?<declarations>[^}]*)\}/u.exec(
      stylesheet,
    );
    expect(center?.groups?.declarations).toContain("stroke-width: 1.5");
    expect(center?.groups?.declarations).toContain("fill: none");
    expect(center?.groups?.declarations).not.toContain("opacity");
  });

  it("keeps every selection handle opaque above transparent outlines", () => {
    const match = /\.inkbook-selection-handles\s*\{(?<declarations>[^}]*)\}/u.exec(stylesheet);
    const declarations = match?.groups?.declarations ?? "";

    expect(declarations).toContain("fill: var(--interactive-accent)");
    expect(declarations).toContain("stroke: var(--interactive-accent)");
    expect(declarations).not.toContain("transparent");
  });
});
