import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  "LICENSE",
  "manifest.json",
  "package.json",
  "versions.json",
  ...["react", "react-dom", "scheduler"].map((name) => `node_modules/${name}/LICENSE`),
];
const sources = Object.fromEntries(
  await Promise.all(
    sourcePaths.map(async (file) => [file, await readFile(path.join(projectRoot, file), "utf8")]),
  ),
);
const license = sources["LICENSE"].trim();
const runtime = 'void "inkbook-plugin-bootstrap";import("data:text/javascript,");';
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
    "dist/main.js": main,
    "dist/manifest.json": sources["manifest.json"],
    "dist/styles.css": ".inkbook-root {}",
    ...overrides,
  });
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

it("rejects removed attribution even when the source and bundle agree", async () => {
  const incompleteLicense = license.replace(
    "Copyright (c) Meta Platforms, Inc. and affiliates.",
    "",
  );
  await expect(
    verify({
      LICENSE: incompleteLicense,
      "dist/main.js": `/*!\n${incompleteLicense}\n*/\n${runtime}`,
    }),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("LICENSE must contain the complete react license notice."),
  });
});

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
