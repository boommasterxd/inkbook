import { describe, expect, it } from "vitest";

import { resolvePresenceButtons } from "../../../../src/rendering/ui/toolbar-presence";

const definitions = [
  { action: "undo", icon: "undo-2", label: "Undo" },
  { action: "redo", icon: "redo-2", label: "Redo" },
] as const;

describe("conditional toolbar control presence", () => {
  it("retains removed controls as non-interactive exits and marks additions as entrances", () => {
    const previous = definitions.map((definition) => ({
      definition,
      presence: "present" as const,
    }));
    expect(resolvePresenceButtons(definitions, [definitions[0]], previous)).toEqual([
      { definition: definitions[0], presence: "present" },
      { definition: definitions[1], presence: "exiting" },
    ]);
    expect(resolvePresenceButtons(definitions, definitions, [])).toEqual([
      { definition: definitions[0], presence: "entering" },
      { definition: definitions[1], presence: "entering" },
    ]);
  });
});
