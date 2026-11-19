import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import { write } from "./ci-selection-fixtures.mjs";

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const directories = [];
const sourcePaths = [
  "scripts/verify-package.mjs",
  "scripts/embedded-package-modules.mjs",
  "src/persistence/worker/runtime/embedded-source.ts",
  "LICENSE",
  "manifest.json",
  "package.json",
  "versions.json",
  "node_modules/brotli-dec-wasm/LICENSE-MIT.txt",
  "src/persistence/fonts/assets/brotli-runtime-licenses.txt",
  "node_modules/@mathjax/src/LICENSE",
  ...["inter", "source-serif", "caveat", "jetbrains-mono"].map(
    (family) => `src/persistence/fonts/assets/${family}-OFL.txt`,
  ),
  ...["react", "react-dom", "scheduler"].map((name) => `node_modules/${name}/LICENSE`),
  ...["motion", "framer-motion", "motion-dom", "motion-utils"].map(
    (name) => `node_modules/${name}/LICENSE.md`,
  ),
];
const sources = Object.fromEntries(
  await Promise.all(
    sourcePaths.map(async (file) => [file, await readFile(path.join(projectRoot, file), "utf8")]),
  ),
);
const license = sources["LICENSE"].trim();
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=";
const packageAssets = {
  "src/obsidian/settings/import/import-example-images.ts": `export const IMPORT_EXAMPLE_IMAGES = [{ before: { src: ${JSON.stringify(png)} }, after: { src: ${JSON.stringify(png)} } }];`,
  "src/persistence/fonts/assets/fixture.woff2": "wOF2package-license-font",
  "node_modules/brotli-dec-wasm/package.json": JSON.stringify({
    exports: { "./web/bg.wasm": "./fixture.wasm" },
  }),
  "node_modules/brotli-dec-wasm/fixture.wasm": new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
};
// Native Base91/gzip runtime with both standalone modules and the two exact binary fixture payloads.
const encodedRuntime =
  "<Ah!!!!!9-SO]:GwAX'#-sf)e_O@c@eO((Y>32e%Y7nqv46eCJ'Nk0sebw.wr[~m9YDY}tb3Ny#Ck9SSu.j,tSuEmy{wJ-_0syN:=fe|&d3b?y^rquF9{55!j6VJWJhbE_uJAisw2%RdqP_AEi6NC)|1;$78Cm_@qNhyH&v/4lyfHZ90U0<<~p2=M<^gx>ft|tp34[A*wz;zYOWrw-grR_dPbA[%M;AM~O?Ca+dBN'urmdh%O2E4ct'_[LFVKnyj2qqE9KX,.,eJs#=qOo-X<|i(E*kpyr_R(6nLDPfI4{W^3q7ok$h^a]7D:I?KW+M]~-5TN.Y!bsetJay1hPw%2/#HU_|xK:^vYSE9#fWjbT,5>H^'[56BEVZ7,e$G;yNe/-o]tp7I_,*BQEqVp;BmoLIce0!DN1WR%?*)AgEXuWDb;wSHm[K4_1-mnCV%}b(+73{%Nd9xV$x}w/E*!7tfHm/wKiAFV!u;<CiJK>vzOvW<o.NB.rli>[owH7E]^*Wlr-v^Mb_B)J{uYY$=F,UJTrIFp+z(6&7-yu%VIBK{sDQ}rh>HQq%kv4Tf8-3A<6Nrud{YBi4!!!";
const runtime = `void "inkbook-plugin-bootstrap";const payload = ${JSON.stringify(encodedRuntime)};import("data:text/javascript,");`;
const main = `/*!\n${license}\n*/\n${runtime}`;

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function verify(overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "inkbook-package-license-"));
  directories.push(root);
  await write(root, {
    ...sources,
    ...packageAssets,
    "dist/main.js": main,
    "dist/manifest.json": sources["manifest.json"],
    "dist/styles.css": ".inkbook-root {}",
    ...overrides,
  });
  await symlink(
    path.join(projectRoot, "node_modules/typescript"),
    path.join(root, "node_modules/typescript"),
    "dir",
  );
  return execute(process.execPath, ["scripts/verify-package.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
}

it("accepts complete upstream notices in the native three-file package", async () => {
  await expect(verify()).resolves.toMatchObject({ stderr: "" });
});

it.each([
  ["missing", runtime],
  ["changed", main.replace("Meta Platforms", "Changed Platforms")],
])("rejects a %s license banner in the distributable", async (_label, outputMain) => {
  await expect(verify({ "dist/main.js": outputMain })).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("dist/main.js must retain the complete LICENSE banner."),
  });
});

it.each([
  ["react", "Copyright (c) Meta Platforms, Inc. and affiliates."],
  ["motion", "Copyright (c) 2024 [Motion](https://motion.dev) B.V."],
  ["framer-motion", "Copyright (c) 2018 Framer B.V."],
])(
  "rejects removed %s attribution even when source and bundle agree",
  async (dependency, notice) => {
    const incompleteLicense = license.replace(notice, "");
    await expect(
      verify({
        LICENSE: incompleteLicense,
        "dist/main.js": `/*!\n${incompleteLicense}\n*/\n${runtime}`,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        `LICENSE must contain the complete ${dependency} license notice.`,
      ),
    });
  },
);

it("rejects dependency license drift requiring refreshed attribution", async () => {
  await expect(
    verify({
      "node_modules/scheduler/LICENSE": `${sources["node_modules/scheduler/LICENSE"]}\nAdditional upstream attribution.`,
    }),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("LICENSE must contain the complete scheduler license notice."),
  });
});
