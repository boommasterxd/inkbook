import { readJson, fail } from "./lib-files.mjs";

const manifest = await readJson("manifest.json");
const packageJson = await readJson("package.json");
const versions = await readJson("versions.json");

if (manifest.id !== "inkbook") fail("manifest.id must be inkbook");
if (manifest.name !== "Inkbook") fail("manifest.name must be Inkbook");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) fail("Invalid manifest version");
if (manifest.version !== packageJson.version)
  fail("Manifest and package versions differ");
if (manifest.minAppVersion !== "1.8.7")
  fail("Unexpected minimum Obsidian version");
if (manifest.isDesktopOnly !== false)
  fail("The plugin must remain mobile-capable");
if (manifest.author !== "Yannick Schäfer")
  fail("The configured author is missing");
if (versions[manifest.version] !== manifest.minAppVersion) {
  fail("versions.json does not map the current release to minAppVersion");
}

console.log("Manifest validation passed.");
