import { describe, expect, it } from "vitest";

import InkbookPlugin from "../src/main";

describe("InkbookPlugin", () => {
  it("loads and unloads without starting product work during bootstrap", async () => {
    const plugin = Object.create(InkbookPlugin.prototype) as InkbookPlugin;

    await expect(plugin.onload()).resolves.toBeUndefined();
    expect(plugin.onunload()).toBeUndefined();
  });
});
