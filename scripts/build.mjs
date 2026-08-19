import { copyFile, mkdir, rm } from "node:fs/promises";

import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");
const outputDirectory = "dist";
const options = {
  bundle: true,
  entryPoints: ["src/main.ts"],
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  legalComments: "none",
  logLevel: "info",
  minify: !watch,
  outfile: `${outputDirectory}/main.js`,
  platform: "browser",
  sourcemap: watch ? "inline" : false,
  target: "es2022",
  treeShaking: true,
};

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  copyFile("manifest.json", `${outputDirectory}/manifest.json`),
  copyFile("src/styles.css", `${outputDirectory}/styles.css`),
]);

if (watch) {
  const buildContext = await context(options);
  await buildContext.watch();
} else {
  await build(options);
}
