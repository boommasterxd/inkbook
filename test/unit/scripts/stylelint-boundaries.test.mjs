import { describe, expect, it } from "vitest";
import stylelint from "stylelint";

import config from "../../../stylelint.config.mjs";

const codeFilename = "src/obsidian/styles/inkbook.css";

async function expectRejected(code, rule, filename = codeFilename) {
  const { errored, results } = await stylelint.lint({ code, codeFilename: filename, config });
  expect(errored).toBe(true);
  const warnings = results.flatMap((result) => result.warnings);
  expect(warnings).toEqual(
    expect.arrayContaining([expect.objectContaining({ rule, severity: "error" })]),
  );
}

describe("owned stylesheet boundaries", () => {
  it("allows owned surfaces, exact scroll leases, platform feedback and host motion suppression", async () => {
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

.inkbook-root {
  animation: none;
  transition: none;
}
`,
      codeFilename,
      config,
    });

    expect(result.errored).toBe(false);
  });

  it.each([
    ["transition: color 120ms", "declaration-property-value-disallowed-list"],
    ["transition-duration: 120ms", "property-disallowed-list"],
    ["animation: owned 120ms", "declaration-property-value-disallowed-list"],
    ["animation-name: owned", "property-disallowed-list"],
  ])("rejects CSS motion through %s", async (declaration, rule) => {
    await expectRejected(`.inkbook-root { ${declaration}; }`, rule);
  });

  it("rejects CSS keyframes", async () => {
    await expectRejected("@keyframes owned { to { opacity: 0; } }", "at-rule-disallowed-list");
  });

  it.each([
    ".menu",
    ".inkbook-root .menu-scroll",
    ".inkbook-root, [data-inkbook-keyboard-navigation='false'] :focus",
    ".inkbook-scrollbar-stable-unowned",
    ".inkbook-scroll-anchor-suppressed .host-child",
    "@media (width <= 600px) { .host-content",
  ])("rejects an unowned selector in %s", async (selector) => {
    await expectRejected(
      `${selector} { display: block; }${selector.startsWith("@media") ? " }" : ""}`,
      "selector-disallowed-list",
      selector === ".menu" ? "src/obsidian/styles/phone-sheet-host.css" : codeFilename,
    );
  });
});
