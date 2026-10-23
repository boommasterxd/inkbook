import type { App } from "obsidian";
import { describe, expect, it } from "vitest";

import {
  findObsidianHotkeyConflict,
  readObsidianHotkeyBindings,
} from "../../../../../src/obsidian/settings/shortcuts/obsidian-hotkey-conflicts";

describe("Obsidian hotkey conflict gateway", () => {
  it("merges current defaults and custom overrides with Obsidian precedence", () => {
    const app = hostApp({
      customKeys: {
        "app:open-command-palette": [],
        "switcher:open": [{ key: "O", modifiers: ["Mod"] }],
      },
      defaultKeys: {
        "app:open-command-palette": [{ key: "P", modifiers: ["Mod"] }],
        "editor:find": [{ key: "F", modifiers: ["Mod"] }],
      },
    });

    expect(findObsidianHotkeyConflict(app, binding("p"))).toBeUndefined();
    expect(findObsidianHotkeyConflict(app, binding("o"))).toBe("switcher:open");
    expect(findObsidianHotkeyConflict(app, binding("f"))).toBe("editor:find");
  });

  it("ignores malformed private state instead of accepting a false conflict", () => {
    const app = hostApp({
      customKeys: { broken: [{ key: 7, modifiers: ["Mod"] }] },
      defaultKeys: "unavailable",
    });

    expect(findObsidianHotkeyConflict(app, binding("p"))).toBeUndefined();
  });

  it("returns an isolated snapshot of effective command bindings", () => {
    const assigned = { key: "L", modifiers: ["Mod"] };
    const app = hostApp({
      customKeys: { "inkbook:lock-active-embed": [assigned] },
      defaultKeys: {},
    });

    const bindings = readObsidianHotkeyBindings(app);
    assigned.key = "X";
    assigned.modifiers.push("Shift");

    expect(bindings.get("inkbook:lock-active-embed")).toEqual([{ key: "L", modifiers: ["Mod"] }]);
  });
});

function binding(key: string) {
  return { key, modifiers: ["mod"] as const };
}

function hostApp(hotkeyManager: unknown): App {
  return { hotkeyManager } as unknown as App;
}
