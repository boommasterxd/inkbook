import { describe, expect, it } from "vitest";

import { resolvePresenceButtons } from "../../../../src/rendering/ui/toolbar-presence";

const definitions = [
  { action: "undo", icon: "undo-2", label: "Undo" },
  { action: "redo", icon: "redo-2", label: "Redo" },
  { action: "copy", icon: "copy", label: "Copy" },
] as const;

describe("conditional toolbar control presence", () => {
  it("retains removed controls as non-interactive exits and marks additions as entrances", () => {
    const previous = definitions.map((definition) => ({
      definition,
      presence: "present" as const,
      presenceOrder: 0,
    }));
    expect(resolvePresenceButtons(definitions, [definitions[0]], previous)).toEqual([
      { definition: definitions[0], presence: "present", presenceOrder: 0 },
      { definition: definitions[1], presence: "exiting", presenceOrder: 1 },
      { definition: definitions[2], presence: "exiting", presenceOrder: 0 },
    ]);
    expect(resolvePresenceButtons(definitions, definitions, [])).toEqual([
      { definition: definitions[0], presence: "entering", presenceOrder: 0 },
      { definition: definitions[1], presence: "entering", presenceOrder: 1 },
      { definition: definitions[2], presence: "entering", presenceOrder: 2 },
    ]);
  });
});
