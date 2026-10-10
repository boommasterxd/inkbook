import { expect, it } from "vitest";
import { SCENE_SURFACE_STYLES } from "../../../../src/rendering/scene/scene-surface-styles";

const stylesheet = SCENE_SURFACE_STYLES;

it.each(["inkbook-selection-area-preview", "inkbook-snap-guide"])(
  "rounds the dashed segments and joins of %s",
  (className) => {
    const selector = `.inkbook-scene-overlays .${className}`;
    expect(stylesheet.indexOf(selector)).toBeGreaterThanOrEqual(0);
    const declarations = stylesheet.slice(stylesheet.indexOf(selector)).split("}")[0]!;
    expect(declarations).toContain("stroke-dasharray: 3 3");
    expect(declarations).toContain("stroke-linecap: round");
    expect(declarations).toContain("stroke-linejoin: round");
  },
);
