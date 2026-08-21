import { Plugin } from "obsidian";
import { describe, expect, it } from "vitest";

import InkbookPlugin from "../../../src/main";

describe("plugin entry point", () => {
  it("exports an Obsidian plugin", () => {
    expect(InkbookPlugin.prototype).toBeInstanceOf(Plugin);
  });
});
