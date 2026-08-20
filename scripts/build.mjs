import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { gzipSync } from "node:zlib";

import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");
const outputDirectory = "dist";
const maximumWorkerBytes = 786_432;
const maximumMainBytes = 2_097_152;
const maximumGzipMainBytes = 524_288;
const maximumStylesBytes = 131_072;
const maximumGzipStylesBytes = 32_768;
const productionFiles = ["main.js", "manifest.json", "styles.css"];
const workerBuild = await build({
  bundle: true,
  entryPoints: ["src/workers/shared-worker-entry.ts"],
  format: "iife",
  legalComments: "none",
  logLevel: "silent",
  minify: !watch,
  platform: "browser",
  target: "es2022",
  treeShaking: true,
  write: false,
});
const workerSource = workerBuild.outputFiles[0]?.text;
if (
  workerSource === undefined ||
  new TextEncoder().encode(workerSource).byteLength > maximumWorkerBytes
) {
  throw new Error("The embedded worker payload exceeds its production bound.");
}
const options = {
  banner: {
    js: `const __INKBOOK_STATIC_WORKER_SOURCE__ = ${JSON.stringify(workerSource)};`,
  },
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
  await verifyProductionPackage();
}

async function verifyProductionPackage() {
  const files = await readdir(outputDirectory);
  files.sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(files) !== JSON.stringify(productionFiles)) {
    throw new Error("The production package contains unexpected artifacts.");
  }
  const [main, manifest, styles] = await Promise.all([
    readFile(`${outputDirectory}/main.js`),
    readFile(`${outputDirectory}/manifest.json`),
    readFile(`${outputDirectory}/styles.css`),
  ]);
  assertArtifactSize(main, maximumMainBytes, maximumGzipMainBytes, "main.js");
  assertArtifactSize(
    styles,
    maximumStylesBytes,
    maximumGzipStylesBytes,
    "styles.css",
  );
  assertCleanProductionText(new TextDecoder().decode(main));
  assertCleanPackageMetadata(new TextDecoder().decode(manifest));
  assertCleanProductionText(new TextDecoder().decode(styles));
}

function assertArtifactSize(bytes, maximumRaw, maximumGzip, name) {
  if (
    bytes.byteLength > maximumRaw ||
    gzipSync(bytes).byteLength > maximumGzip
  ) {
    throw new Error(`${name} exceeds its production artifact bounds.`);
  }
}

function assertCleanProductionText(value) {
  const forbidden = [
    /sourceMappingURL/u,
    /(?:^|["'])electron(?:["']|$)/iu,
    /\brequire\(["'](?:node:|fs["'/]|path["'/]|child_process|worker_threads|vm["'/]|[^"']+\.node["'])/u,
    /\b(?:eval|importScripts)\s*\(/u,
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/u,
    /https?:\/\//u,
    /(?:\/home\/|\/Users\/|[A-Z]:\\|Development\/Projects)/u,
    /\bconsole\.(?:debug|trace)\s*\(/u,
    /__INKBOOK_(?:DEBUG|PROBE)|development-probe/iu,
  ];
  if (forbidden.some((pattern) => pattern.test(value))) {
    throw new Error("The production package contains forbidden runtime text.");
  }
}

function assertCleanPackageMetadata(value) {
  const forbidden = [
    /sourceMappingURL/u,
    /(?:^|["'])electron(?:["']|$)/iu,
    /\brequire\(["'](?:node:|fs["'/]|path["'/]|child_process|worker_threads|vm["'/]|[^"']+\.node["'])/u,
    /\b(?:eval|importScripts|fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/u,
    /(?:\/home\/|\/Users\/|[A-Z]:\\|Development\/Projects)/u,
    /\bconsole\.(?:debug|trace)\s*\(/u,
    /__INKBOOK_(?:DEBUG|PROBE)|development-probe/iu,
  ];
  if (forbidden.some((pattern) => pattern.test(value))) {
    throw new Error("The production metadata contains forbidden content.");
  }
}
