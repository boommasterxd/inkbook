import { readFile } from "node:fs/promises";

import Ajv from "ajv";
import addFormats from "ajv-formats";

import { fail, readJson } from "./lib-files.mjs";

const manifests = [
  [
    "test/compatibility/compatibility-matrix.schema.json",
    "test/compatibility/compatibility-matrix.json",
  ],
  [
    "test/benchmarks/benchmark-manifest.schema.json",
    "test/benchmarks/benchmark-manifest.json",
  ],
];

for (const [schemaPath, dataPath] of manifests) {
  const schema = await readJson(schemaPath);
  const data = await readJson(dataPath);
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(data))
    fail(`${dataPath} is invalid: ${JSON.stringify(validate.errors)}`);
}

if (process.argv.includes("--require-ready")) {
  const matrix = await readJson("test/compatibility/compatibility-matrix.json");
  const incomplete = matrix.cells.filter((cell) => cell.status !== "ready");
  if (incomplete.length > 0) {
    fail(
      `Phase exit blocked by compatibility cells: ${incomplete.map((cell) => cell.id).join(", ")}`,
    );
  }
  const benchmark = await readJson("test/benchmarks/benchmark-manifest.json");
  if (benchmark.status !== "frozen")
    fail("Phase exit requires a frozen benchmark manifest");
}

await readFile("test/manual/manual-acceptance.schema.json", "utf8");
console.log("Test manifest validation passed.");
