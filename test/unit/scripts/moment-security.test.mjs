import Module, { createRequire } from "node:module";

import { afterEach, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const moment = require("moment");
const originalLocale = moment.locale();

afterEach(() => {
  moment.locale(originalLocale);
  vi.restoreAllMocks();
});

it("preserves date formatting with the overridden Moment dependency", () => {
  expect(moment.utc("2026-10-11", "YYYY-MM-DD", true).format("YYYY-MM-DD")).toBe("2026-10-11");
});

it("does not load a module through a coercible non-string locale name", () => {
  const load = vi.spyOn(Module, "_load");
  const name = {
    [Symbol.toPrimitive](hint) {
      return hint === "default" ? "../package.json" : "inkbook-locale-probe";
    },
    match() {
      return ["inkbook-locale-probe"];
    },
    toLowerCase() {
      return this;
    },
    replace() {
      return this;
    },
    split() {
      return ["en"];
    },
  };

  expect(moment.locale(name)).toBe("en");
  expect(load.mock.calls.map(([request]) => request)).not.toContain("./locale/../package.json");
});
