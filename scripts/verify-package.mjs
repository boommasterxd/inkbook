import { readFile, readdir } from "node:fs/promises";

const parseJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const manifest = await parseJson("manifest.json");
const packageManifest = await parseJson("package.json");
const versions = await parseJson("versions.json");
const semanticVersion = /^\d+\.\d+\.\d+$/u;

if (!semanticVersion.test(manifest.version)) {
  throw new Error("manifest.version must be an x.y.z semantic version.");
}

if (manifest.version !== packageManifest.version) {
  throw new Error("manifest.json and package.json versions must match.");
}

if (versions[manifest.version] !== manifest.minAppVersion) {
  throw new Error("versions.json must map the current version to minAppVersion.");
}

if (!/^[a-z][a-z-]*$/u.test(manifest.id) || manifest.id.includes("obsidian")) {
  throw new Error("manifest.id does not satisfy the Obsidian naming contract.");
}

if (manifest.id.endsWith("plugin")) {
  throw new Error("manifest.id must not end with plugin.");
}

if (
  typeof manifest.description !== "string" ||
  manifest.description.length > 250 ||
  !manifest.description.endsWith(".")
) {
  throw new Error("manifest.description must be at most 250 characters and end with a period.");
}

if (manifest.isDesktopOnly !== false) {
  throw new Error("Inkbook must remain available on mobile.");
}

const expectedFiles = ["main.js", "manifest.json", "styles.css"];
const actualFiles = (await readdir("dist")).sort();

if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(`dist must contain only ${expectedFiles.join(", ")}.`);
}

const [sourceManifest, outputManifest, outputMain, outputStyles] = await Promise.all([
  readFile("manifest.json", "utf8"),
  readFile("dist/manifest.json", "utf8"),
  readFile("dist/main.js", "utf8"),
  readFile("dist/styles.css", "utf8"),
]);

if (sourceManifest !== outputManifest) {
  throw new Error("dist/manifest.json does not match manifest.json.");
}

if (outputMain.trim().length === 0 || outputMain.includes("sourceMappingURL")) {
  throw new Error("dist/main.js must be non-empty and contain no source map reference.");
}

if (!outputStyles.includes(".inkbook-root")) {
  throw new Error("dist/styles.css does not contain the scoped Inkbook root styles.");
}
