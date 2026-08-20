/* eslint-disable @typescript-eslint/no-magic-numbers -- Normative recovery limits are the tested contract. */
import { describe, expect, it } from "vitest";

import { RECOVERY_STORE_LIMITS_V1 } from "../../../src/application/recovery";
import { createSceneRevision } from "../../../src/domain/model";
import {
  createSidecarRevision,
  createSourceGeneration,
} from "../../../src/application/note-session";
import {
  BASE,
  DIGEST_A,
  existingLoad,
  openStore,
  preparedAttempt,
} from "./support";

describe("IndexedDB recovery performance contracts", () => {
  it("PERF-10K-RECOVERY-CLEANUP cleans the exact 512-successor tier atomically", async () => {
    const { store } = await openStore("performance-cleanup-512");
    const coveredAttemptIds = [];
    for (
      let index = 1;
      index <= RECOVERY_STORE_LIMITS_V1.maxDirectSuccessorsPerBase;
      index += 1
    ) {
      const attempt = preparedAttempt(index, index);
      coveredAttemptIds.push(attempt.attemptId);
      const result = await store.prepareForward(attempt);
      expect(result.ok).toBe(true);
    }
    await expect(
      store.prepareForward(preparedAttempt(513, 513)),
    ).resolves.toEqual({
      ok: false,
      code: "recovery-limit",
    });
    await expect(
      store.acknowledgeSidecar({
        acknowledgedReplacementBase: {
          ...BASE,
          rawTextSha256: DIGEST_A,
          revision: createSidecarRevision(2),
        },
        coveredAttemptIds,
        coveredCheckpointIds: [],
        expectedPriorBase: BASE,
        noteIdentity: {
          vaultIdHint: "vault-fixture",
          vaultRelativeMarkdownPath: BASE.markdownPath,
        },
        sceneRevision: createSceneRevision(2),
        sidecarRevision: createSidecarRevision(2),
        sourceDigest: DIGEST_A,
        sourceGeneration: createSourceGeneration(1),
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await expect(store.loadNote(existingLoad())).resolves.toMatchObject({
      ok: true,
      value: { attempts: [] },
    });
    await store.dispose();
  }, 30_000);

  it("PERF-10K-TEARDOWN reserves completion queue capacity and rejects work after disposal", async () => {
    const { store } = await openStore("performance-queue-release", {
      limits: { queuedOperations: 8 },
    });
    const admitted = Array.from({ length: 4 }, (_, index) =>
      store.prepareForward(preparedAttempt(index + 1, index + 1)),
    );
    await expect(store.prepareForward(preparedAttempt(5, 5))).resolves.toEqual({
      ok: false,
      code: "recovery-limit",
    });
    await expect(Promise.all(admitted)).resolves.toEqual(
      Array.from({ length: 4 }, () => ({ ok: true, value: undefined })),
    );
    await store.dispose();
    await expect(store.loadNote(existingLoad())).resolves.toEqual({
      ok: false,
      code: "disposed",
    });
  });
});
