import { sys } from "typescript";
import { expect, it } from "vitest";

const stylesheet = sys.readFile(sys.resolvePath("src/obsidian/styles/inkbook.css"))!;

it.each(["inkbook-selection-area-preview", "inkbook-snap-guide"])(
  "rounds the dashed segments and joins of %s",
  (className) => {
    const selector = `.inkbook-root .inkbook-scene-overlays .${className}`;
    const declarations = stylesheet.slice(stylesheet.indexOf(selector)).split("}")[0]!;
    expect(declarations).toContain("stroke-dasharray: 3 3");
    expect(declarations).toContain("stroke-linecap: round");
    expect(declarations).toContain("stroke-linejoin: round");
  },
);
