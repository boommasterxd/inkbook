import { readFile, stat } from "node:fs/promises";

import { fail, readJson } from "./lib-files.mjs";

const artifacts = ["main.js", "manifest.json", "styles.css"];
for (const artifact of artifacts) {
  const metadata = await stat(artifact).catch(() => null);
  if (!metadata?.isFile()) fail(`Missing release artifact: ${artifact}`);
}

const manifest = await readJson("manifest.json");
const packageJson = await readJson("package.json");
const bundle = await readFile("main.js", "utf8");

if (manifest.version !== packageJson.version)
  fail("Release versions do not match");
if (Object.keys(packageJson.scripts)[0] !== "build") {
  fail("The first Community scanner build script must be build");
}
if (bundle.includes("sourceMappingURL="))
  fail("Production bundle contains a source map");
if (Buffer.byteLength(bundle) > 2 * 1024 * 1024)
  fail("Bootstrap bundle exceeds 2 MiB");

console.log(
  "Package validation passed for main.js, manifest.json, and styles.css.",
);
