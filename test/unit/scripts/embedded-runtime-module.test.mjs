import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

import { wrapPluginRuntime } from "../../../scripts/embedded-runtime-module.mjs";

it.each([false, true])("loads the runtime activation export with minify=%s", async (minify) => {
  const runtime = await build({
    stdin: {
      contents: `import { name } from "obsidian";
import { standardKeymap } from "@codemirror/commands";
export function activateInkbookPlugin() { return name + ":" + standardKeymap.length; }`,
    },
    bundle: true,
    external: ["obsidian", "@codemirror/commands"],
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
      `globalThis.__inkbookHostModules = { obsidian: { name: "native-host-module" }, "@codemirror/commands": { standardKeymap: ["source-command"] } };
const runtime = await import(${JSON.stringify(url)});
process.stdout.write(runtime.activateInkbookPlugin());`,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(activation).toBe("native-host-module:1");
});

it.each(["node:fs", "@codemirror/not-hosted"])(
  "rejects the unlisted host module %s",
  (moduleId) => {
    expect(() => wrapPluginRuntime(`const dependency = require("${moduleId}");`)).toThrow(
      `Plugin runtime requires unsupported host module: ${moduleId}`,
    );
  },
);
