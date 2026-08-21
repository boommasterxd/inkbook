import { copyFile, mkdir, rm } from "node:fs/promises";

import { build, context } from "esbuild";

const production = !process.argv.includes("--watch");
const buildOptions = {
  bundle: true,
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
  sourcemap: production ? false : "inline",
  target: "es2021",
};

async function copyManifest() {
  await mkdir("dist", { recursive: true });
  await copyFile("manifest.json", "dist/manifest.json");
}

await rm("dist", { force: true, recursive: true });

if (production) {
  await build(buildOptions);
  await copyManifest();
} else {
  const buildContext = await context({
    ...buildOptions,
    plugins: [
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
