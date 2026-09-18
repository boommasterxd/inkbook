import { describe, expect, it } from "vitest";

import { saveExistingFile } from "../../../src/persistence/saving/save-existing";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import { sha256Hex } from "../../../src/persistence/serialization/sha256";
import { createStandardPersistenceFixture } from "./fixtures";

describe("persistence serialization performance", () => {
  it("reuses one exact-base save preparation across repeated host callback attempts", async () => {
    const serialized = serializeInkbookDocument(createStandardPersistenceFixture(), {
      hash: () => "fixture-hash",
    });
    if (!serialized.ok) throw new Error(serialized.error.message);
    const base = copyString(serialized.value.svg);
    const next = base
      .replace('data-inkbook-revision="1"', 'data-inkbook-revision="2"')
      .replace('"revision":1', '"revision":2');
    const outputHash = sha256Hex(next);
    await exactBaseSave(base, next, outputHash);
  }, 120_000);
});

function copyString(value: string): string {
  return new TextDecoder().decode(new TextEncoder().encode(value));
}

async function exactBaseSave(base: string, next: string, outputHash: string): Promise<void> {
  let persisted = base;
  let processCalls = 0;
  let readCalls = 0;
  let verificationCalls = 0;
  const save = await saveExistingFile(
    {
      expectedBase: base,
      output: next,
      outputHash,
      path: "fixture.svg",
      revision: 2,
    },
    { currentRevision: () => 2 },
    {
      process: async (_path, update) => {
        processCalls += 1;
        // Hosts may invoke the updater repeatedly before committing its result.
        expect(update(copyString(base))).toBe(next);
        persisted = update(copyString(base));
        expect(persisted).toBe(next);
        return persisted;
      },
      readWithMetadataGuard: async (path) => {
        readCalls += 1;
        const size = new TextEncoder().encode(persisted).byteLength;
        return {
          content: persisted,
          identity: { ctime: 1, mtime: 1, path, size },
          materialization: "host-full-read-not-bounded" as const,
          stabilityEvidence: "object-identity-and-stat-unchanged" as const,
        };
      },
    },
    {
      verify: async (content, revision, hash) => {
        verificationCalls += 1;
        return content === next && revision === 2 && hash === outputHash;
      },
    },
  );
  expect(save.revision).toBe(2);
  expect(persisted).toBe(next);
  expect(processCalls).toBe(1);
  expect(readCalls).toBe(2);
  expect(verificationCalls).toBe(1);
}
