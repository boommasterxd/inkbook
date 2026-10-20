import { describe, expect, it } from "vitest";
import stylelint from "stylelint";

import config from "../../../stylelint.config.mjs";

const codeFilename = "src/obsidian/styles/inkbook.css";

describe("owned stylesheet boundaries", () => {
  it("allows owned surfaces, exact scroll leases, platform feedback and animation stages", async () => {
    const result = await stylelint.lint({
      code: `
.inkbook-root .inkbook-canvas-input,
.inkbook-menu-choice,
.inkbook-adaptive-panel,
.inkbook-tool-cursor-surface svg,
.inkbook-owned-menu,
.inkbook-scrollbar-stable,
.inkbook-scroll-anchor-suppressed,
.is-phone .inkbook-root.inkbook-feedback-host {
  display: block;
}

@keyframes inkbook-presence {
  from { opacity: 0; }
  to { opacity: 1; }
}
`,
      codeFilename,
      config,
    });

    expect(result.errored).toBe(false);
  });

  it.each([
    ".menu",
    ".inkbook-root .menu-scroll",
    ".inkbook-root, [data-inkbook-keyboard-navigation='false'] :focus",
    ".inkbook-scrollbar-stable-unowned",
    ".inkbook-scroll-anchor-suppressed .host-child",
    "@media (width <= 600px) { .host-content",
  ])("rejects an unowned selector in %s", async (selector) => {
    const result = await stylelint.lint({
      code: `${selector} { display: block; }${selector.startsWith("@media") ? " }" : ""}`,
      codeFilename:
        selector === ".menu" ? "src/obsidian/styles/phone-sheet-host.css" : codeFilename,
      config,
    });

    expect(result.errored).toBe(true);
    expect(result.results.flatMap(({ warnings }) => warnings)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "selector-disallowed-list", severity: "error" }),
      ]),
    );
  });
});
