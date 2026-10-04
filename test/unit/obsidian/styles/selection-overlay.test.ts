import { describe, expect, it } from "vitest";
import { SCENE_SURFACE_STYLES } from "../../../../src/rendering/scene/scene-surface-styles";

const stylesheet = SCENE_SURFACE_STYLES;

describe("selection overlay styles", () => {
  it("centers the frame at normal width and suppresses only a duplicate rectangle outline", () => {
    const frame =
      /\.inkbook-selection-overlay\[data-center-outline="true"\]\s*\{(?<declarations>[^}]*)\}/u.exec(
        stylesheet,
      );
    expect(frame?.groups?.declarations).toContain("stroke: none");
    expect(frame?.groups?.declarations).not.toContain("fill:");
    const shared = /\.inkbook-scene-overlays path\s*\{(?<declarations>[^}]*)\}/u.exec(stylesheet);
    expect(shared?.groups?.declarations).toContain("stroke-width: 1.5");
    expect(shared?.groups?.declarations).toContain("18%, transparent");
  });

  it("uses opaque, unfilled accent center indicators", () => {
    const center = /\.inkbook-selection-center-trace\s*\{(?<declarations>[^}]*)\}/u.exec(
      stylesheet,
    );
    expect(center?.groups?.declarations).toContain("stroke: var(--interactive-accent)");
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
