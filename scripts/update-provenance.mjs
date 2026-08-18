import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";

import canonicalize from "canonicalize";

import {
  describeArtifact,
  listProvenanceArtifacts,
} from "./provenance-files.mjs";

const LOG_PATH = "provenance/clean-room.jsonl";
const existingText = await readFile(LOG_PATH, "utf8").catch(() => "");
const records = existingText.trim()
  ? existingText.trim().split("\n").map(JSON.parse)
  : [];
const latestByPath = new Map();

for (const record of records) {
  latestByPath.set(record.artifactPath, {
    record,
    recordSha256: digest(canonicalize(record)),
  });
}

const additions = [];
for (const artifactPath of await listProvenanceArtifacts()) {
  const artifactBytes = await readFile(artifactPath);
  const artifactSha256 = digest(artifactBytes);
  const previous = latestByPath.get(artifactPath);
  if (previous?.record.artifactSha256 === artifactSha256) continue;
  const evidence = describeArtifact(artifactPath);
  additions.push({
    schemaVersion: 1,
    artifactPath,
    artifactSha256,
    ...evidence,
    authorAttestation:
      "Created independently from the specification and allowed public evidence.",
    supersedesRecordSha256: previous?.recordSha256 ?? null,
    reviewedBy: "Codex",
    reviewedAtUtc: new Date().toISOString(),
  });
}

if (additions.length > 0) {
  const prefix = existingText && !existingText.endsWith("\n") ? "\n" : "";
  const payload = additions.map((record) => canonicalize(record)).join("\n");
  await appendFile(LOG_PATH, `${prefix}${payload}\n`, "utf8");
}

console.log(`Appended ${additions.length} clean-room provenance records.`);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
