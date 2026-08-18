import { copyFile } from "node:fs/promises";

import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");
const options = {
  bundle: true,
  entryPoints: ["src/main.ts"],
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  legalComments: "none",
  logLevel: "info",
  minify: !watch,
  outfile: "main.js",
  platform: "browser",
  sourcemap: watch ? "inline" : false,
  target: "es2022",
  treeShaking: true,
};

await copyFile("src/styles.css", "styles.css");

if (watch) {
  const buildContext = await context(options);
  await buildContext.watch();
} else {
  await build(options);
}
