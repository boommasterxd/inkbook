import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import Ajv from "ajv";
import addFormats from "ajv-formats";
import canonicalize from "canonicalize";

import { fail, readJson } from "./lib-files.mjs";
import { listProvenanceArtifacts } from "./provenance-files.mjs";

const schema = await readJson("provenance/clean-room.schema.json");
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const lines = (await readFile("provenance/clean-room.jsonl", "utf8"))
  .trim()
  .split("\n");
const records = lines.map((line) => JSON.parse(line));
const latestByPath = new Map();
const recordHashes = new Set();

for (const record of records) {
  if (!validate(record))
    fail(`Invalid provenance record: ${JSON.stringify(validate.errors)}`);
  if (
    record.sourceReferences.some((reference) =>
      reference.includes("obsidian_ink"),
    )
  ) {
    fail(`Forbidden adjacent-project reference in ${record.artifactPath}`);
  }
  const recordSha256 = digest(canonicalize(record));
  if (recordHashes.has(recordSha256))
    fail(`Duplicate provenance record ${recordSha256}`);
  recordHashes.add(recordSha256);
  const previous = latestByPath.get(record.artifactPath);
  if (record.supersedesRecordSha256 !== (previous?.recordSha256 ?? null)) {
    fail(`Broken provenance chain for ${record.artifactPath}`);
  }
  latestByPath.set(record.artifactPath, { record, recordSha256 });
}

const artifacts = await listProvenanceArtifacts();
if (latestByPath.size !== artifacts.length)
  fail("Provenance paths do not match project artifacts");
for (const artifactPath of artifacts) {
  const latest = latestByPath.get(artifactPath);
  if (!latest) fail(`Missing provenance for ${artifactPath}`);
  const actual = digest(await readFile(artifactPath));
  if (latest.record.artifactSha256 !== actual)
    fail(`Stale provenance for ${artifactPath}`);
}

console.log(`Provenance validation passed for ${artifacts.length} artifacts.`);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
