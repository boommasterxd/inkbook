import type { InkbookSidecarV1 } from "../../../src/application/persistence";
import {
  createSourceGeneration,
  parseSha256Digest,
} from "../../../src/application/note-session";
import { completeScene } from "../../domain/codecs/scene-support";

const SHA256_HEX_LENGTH = 64;

export function completeSidecar(): InkbookSidecarV1 {
  return {
    format: "inkbook-obsidian-annotations",
    schemaVersion: { major: 1, minor: 0 },
    noteIdentity: {
      vaultRelativeMarkdownPath: "Notes/Example.md",
      markdownContentDigest: parseSha256Digest("a".repeat(SHA256_HEX_LENGTH)),
      sourceGeneration: createSourceGeneration(1),
    },
    storageLayout: {
      kind: "vault-root",
      vaultRelativeRoot: "Annotations",
    },
    revision: 1,
    baseRevision: null,
    savedAtEpochMs: 1_755_734_400_000,
    scene: completeScene(),
  };
}
