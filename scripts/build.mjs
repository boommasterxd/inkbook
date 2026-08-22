import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { build, context } from "esbuild";
import { minify } from "terser";

const production = !process.argv.includes("--watch");
const workerEntry = resolve("src/persistence/worker/runtime/document-worker-entry.ts");
const workerSourceModule = resolve("src/persistence/worker/runtime/worker-source.ts");
const editorChromeEntry = resolve("src/rendering/ui/editor-chrome-entry.ts");
const editorChromeSourceModule = resolve("src/rendering/ui/editor-chrome-source.ts");
const pluginRuntimeEntry = resolve("src/obsidian/plugin-runtime-entry.ts");
const pluginRuntimeSourceModule = resolve("src/obsidian/plugin-runtime-source.ts");
const pluginRuntimeHostModules = new Set([
  "@codemirror/language",
  "@codemirror/state",
  "@codemirror/view",
  "obsidian",
]);
const base91Alphabet =
  "!#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_abcdefghijklmnopqrstuvwxyz{|}~";
const terserOptions = {
  compress: { passes: 3, toplevel: true, unsafe_arrows: true },
  ecma: 2022,
  format: { comments: false },
  mangle: { toplevel: true },
};

async function optimizeJavaScript(source, module = false) {
  const optimized = await minify(source, { ...terserOptions, module });
  if (optimized.code === undefined) throw new Error("Production minification produced no output.");
  return optimized.code;
}

function encodeBase91(bytes) {
  let encoded = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer |= byte << bits;
    bits += 8;
    if (bits <= 13) continue;
    let value = buffer & 8191;
    const consumed = value > 88 ? 13 : 14;
    if (consumed === 14) value = buffer & 16383;
    buffer >>>= consumed;
    bits -= consumed;
    encoded += base91Alphabet[value % 91] + base91Alphabet[Math.floor(value / 91)];
  }
  if (bits > 0) {
    encoded += base91Alphabet[buffer % 91];
    if (bits > 7 || buffer > 90) encoded += base91Alphabet[Math.floor(buffer / 91)];
  }
  return encoded;
}

function embeddedJavaScript({
  entry,
  external = [],
  filter,
  format,
  marker,
  name,
  plugins = [],
  sourceModule,
  token,
  wrap = (source) => source,
}) {
  // Compression keeps distribution compact; the complete executable entries remain public source.
  return {
    name,
    setup(pluginBuild) {
      pluginBuild.onLoad({ filter }, async ({ path }) => {
        if (resolve(path) !== sourceModule) return undefined;
        const embeddedBuild = await build({
          bundle: true,
          charset: "utf8",
          entryPoints: [entry],
          external,
          format,
          logLevel: "silent",
          metafile: true,
          minify: production,
          platform: "browser",
          plugins,
          sourcemap: false,
          target: "es2022",
          write: false,
        });
        const output = embeddedBuild.outputFiles[0];
        if (output === undefined) throw new Error(`${name} build produced no JavaScript.`);
        const bundledSource = production
          ? await optimizeJavaScript(output.text, format === "esm")
          : output.text;
        const embeddedSource = wrap(bundledSource);
        if (!embeddedSource.includes(marker)) {
          throw new Error(`${name} build is missing its runtime marker.`);
        }
        const source = await readFile(sourceModule, "utf8");
        const compressedSource = encodeBase91(gzipSync(embeddedSource, { level: 9, memLevel: 9 }));
        return {
          contents: source.replace(token, () => compressedSource),
          loader: "ts",
          watchFiles: Object.keys(embeddedBuild.metafile.inputs).map((path) => resolve(path)),
        };
      });
    },
  };
}

const embeddedDocumentWorker = embeddedJavaScript({
  entry: workerEntry,
  filter: /worker-source\.ts$/,
  format: "iife",
  marker: "inkbook-worker-bootstrap",
  name: "embedded-document-worker",
  sourceModule: workerSourceModule,
  token: "__INKBOOK_DOCUMENT_WORKER_SOURCE__",
});

const embeddedEditorChrome = embeddedJavaScript({
  entry: editorChromeEntry,
  filter: /editor-chrome-source\.ts$/,
  format: "esm",
  marker: "mountEditorChrome",
  name: "embedded-editor-chrome",
  sourceModule: editorChromeSourceModule,
  token: "__INKBOOK_EDITOR_CHROME_SOURCE__",
});

function wrapPluginRuntime(source) {
  const requiredModules = [...source.matchAll(/require\("([^"]+)"\)/gu)].map((match) => match[1]);
  const unsupportedModule = requiredModules.find(
    (moduleId) => moduleId === undefined || !pluginRuntimeHostModules.has(moduleId),
  );
  if (unsupportedModule !== undefined) {
    throw new Error(`Plugin runtime requires unsupported host module: ${unsupportedModule}`);
  }
  return `const hostModules=globalThis.__inkbookHostModules;
if(hostModules===undefined)throw new Error("Inkbook host modules are unavailable.");
const require=id=>{const dependency=hostModules[id];if(dependency===undefined)throw new Error("Unsupported Inkbook host module: "+id);return dependency;};
const module={exports:{}},exports=module.exports;
${source}
const activateInkbookPlugin=module.exports.activateInkbookPlugin;
export{activateInkbookPlugin};`;
}

const embeddedPluginRuntime = embeddedJavaScript({
  entry: pluginRuntimeEntry,
  external: ["obsidian", "@codemirror/*", "@lezer/*"],
  filter: /plugin-runtime-source\.ts$/,
  format: "cjs",
  marker: "inkbook-plugin-bootstrap",
  name: "embedded-plugin-runtime",
  plugins: [embeddedDocumentWorker, embeddedEditorChrome],
  sourceModule: pluginRuntimeSourceModule,
  token: "__INKBOOK_PLUGIN_RUNTIME_SOURCE__",
  wrap: wrapPluginRuntime,
});

const buildOptions = {
  bundle: true,
  charset: "utf8",
  entryNames: "[name]",
  entryPoints: {
    main: "src/main.ts",
    styles: "src/obsidian/styles/inkbook.css",
  },
  external: ["obsidian", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  logLevel: "info",
  minify: production,
  outdir: "dist",
  platform: "browser",
  plugins: [embeddedPluginRuntime],
  sourcemap: production ? false : "inline",
  target: "es2022",
};

async function copyManifest() {
  await mkdir("dist", { recursive: true });
  await copyFile("manifest.json", "dist/manifest.json");
}

async function optimizeMainBundle() {
  const outputPath = resolve("dist/main.js");
  const source = await readFile(outputPath, "utf8");
  await writeFile(outputPath, await optimizeJavaScript(source), "utf8");
}

await rm("dist", { force: true, recursive: true });

if (production) {
  await build(buildOptions);
  await optimizeMainBundle();
  await copyManifest();
} else {
  const buildContext = await context({
    ...buildOptions,
    plugins: [
      embeddedPluginRuntime,
      {
        name: "copy-manifest",
        setup(pluginBuild) {
          pluginBuild.onEnd(copyManifest);
        },
      },
    ],
  });
  await buildContext.watch();
  process.on("SIGINT", async () => {
    await buildContext.dispose();
    process.exitCode = 0;
  });
}
