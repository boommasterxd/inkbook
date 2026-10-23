import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

import { wrapPluginRuntime } from "../../../scripts/embedded-runtime-module.mjs";

it.each([false, true])("loads the runtime activation export with minify=%s", async (minify) => {
  const runtime = await build({
    stdin: {
      contents: `import { name } from "obsidian";
export function activateInkbookPlugin() { return name; }`,
    },
    bundle: true,
    external: ["obsidian"],
    format: "cjs",
    minify,
    platform: "browser",
    write: false,
  });
  const source = wrapPluginRuntime(runtime.outputFiles[0].text);
  const url = `data:text/javascript,${encodeURIComponent(source)}`;
  const activation = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `globalThis.__inkbookHostModules = { obsidian: { name: "native-host-module" } };
const runtime = await import(${JSON.stringify(url)});
process.stdout.write(runtime.activateInkbookPlugin());`,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(activation).toBe("native-host-module");
});

it("rejects a runtime requiring a module outside the native host boundary", () => {
  expect(() => wrapPluginRuntime('const fs = require("node:fs");')).toThrow(
    "Plugin runtime requires unsupported host module: node:fs",
  );
});
