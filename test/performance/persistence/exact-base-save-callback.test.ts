import { describe, expect, it } from "vitest";

import { saveExistingFile } from "../../../src/persistence/saving/save-existing";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import { sha256Hex } from "../../../src/persistence/serialization/sha256";
import { statisticalSamples } from "../sample-policy";
import { createStandardPersistenceFixture } from "./fixtures";
import { annotateDurations, expectProfileBudget, measure } from "./metrics";

describe("persistence serialization performance", () => {
  it("keeps the synchronous exact-base callback inside the autosave slice budget", async ({
    annotate,
  }) => {
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
    const callbackDurations: number[] = [];
    for (let run = 0; run < statisticalSamples(5); run += 1) {
      callbackDurations.push(await exactBaseSave(base, next, outputHash));
    }
    await annotateDurations(annotate, "Vault.process exact-base callback", callbackDurations);
    expectProfileBudget(callbackDurations, 8);
  }, 120_000);
});

function copyString(value: string): string {
  return new TextDecoder().decode(new TextEncoder().encode(value));
}

async function exactBaseSave(base: string, next: string, outputHash: string): Promise<number> {
  const currentCopy = copyString(base);
  let persisted = base;
  let callbackDuration = Number.POSITIVE_INFINITY;
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
        const callback = measure(() => update(currentCopy));
        callbackDuration = callback.durationMs;
        persisted = callback.value;
        return persisted;
      },
      readWithMetadataGuard: async (path) => {
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
      verify: async (content, revision, hash) =>
        content === next && revision === 2 && hash === outputHash,
    },
  );
  expect(save.revision).toBe(2);
  return callbackDuration;
}
