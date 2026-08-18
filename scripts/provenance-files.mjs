import { listFiles } from "./lib-files.mjs";

const GENERATED_OR_SELF = new Set([
  "main.js",
  "provenance/clean-room.jsonl",
  "styles.css",
]);

export async function listProvenanceArtifacts() {
  return (await listFiles()).filter((file) => !GENERATED_OR_SELF.has(file));
}

export function describeArtifact(artifactPath) {
  if (artifactPath === "package-lock.json") {
    return {
      artifactKind: "configuration",
      dependencyLicense: "Artistic-2.0",
      dependencyName: "npm dependency graph",
      dependencyVersion: "lockfileVersion 3",
      origin: "dependency",
      purpose: "Records the exact reviewed dependency graph used by npm ci.",
      sourceReferences: ["docs/decisions/0002-toolchain-and-build.md"],
    };
  }
  if (artifactPath.endsWith(".md")) {
    return evidence(
      "documentation",
      "specification",
      "Documents the Inkbook project contract.",
    );
  }
  if (artifactPath.startsWith("src/")) {
    return evidence(
      "code",
      "specification",
      "Implements the independently specified plugin.",
    );
  }
  if (artifactPath.startsWith("test/")) {
    const kind = artifactPath.endsWith(".ts") ? "test" : "fixture";
    return evidence(
      kind,
      "specification",
      "Verifies or records the specified behavior.",
    );
  }
  if (artifactPath.startsWith("scripts/")) {
    return evidence(
      "code",
      "independent-design",
      "Implements repository validation tooling.",
    );
  }
  if (artifactPath.startsWith("docs/specification/mockup/")) {
    return evidence(
      "asset",
      "specification",
      "Provides the non-normative toolbar design mockup.",
    );
  }
  return evidence(
    "configuration",
    "independent-design",
    "Configures the reviewed project toolchain.",
  );
}

function evidence(artifactKind, origin, purpose) {
  return {
    artifactKind,
    dependencyLicense: null,
    dependencyName: null,
    dependencyVersion: null,
    origin,
    purpose,
    sourceReferences: [
      "docs/decisions/0001-clean-room-implementation.md",
      "docs/specification/11-implementation-roadmap.md",
    ],
  };
}
