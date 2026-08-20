import {
  createPersistenceCodecFallbackProcessorV1,
  type InkbookSidecarV1,
  type PersistenceCodecWorkResultV1,
  type PersistenceCodecWorkV1,
} from "../../../src/application/persistence";
import { PersistenceElementChunkCacheV1 } from "../../../src/application/persistence/element-chunk-cache";
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

export function executePersistenceCodecProcessor(
  work: PersistenceCodecWorkV1,
  elementCache = new PersistenceElementChunkCacheV1(),
): PersistenceCodecWorkResultV1 {
  const processor = createPersistenceCodecFallbackProcessorV1(
    work,
    elementCache,
  );
  try {
    while (!processor.processNext()) {
      // Drive the canonical resumable processor without a second production runner.
    }
    return processor.complete();
  } finally {
    processor.dispose();
  }
}
