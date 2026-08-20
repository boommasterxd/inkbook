import { describe, expect, it } from "vitest";

import {
  enqueueRuntimeSaveV1,
  markRuntimeSaveDirtyV1,
} from "../../../src/adapters/obsidian/runtime-persistence-save";
import {
  createSaveGeneration,
  parseRecoveryAttemptId,
  parseSourceCheckpointId,
  type NoteSessionSnapshotV1,
} from "../../../src/application/note-session";
import type {
  SaveGenerationRequestV1,
  SavePipeline,
  SaveStartScheduler,
} from "../../../src/application/persistence";
import type { PreparedSidecarWrite } from "../../../src/adapters/obsidian/vault-sidecar/repository";
import { createTestSession } from "../../application/note-session/session-support";

function request(
  session: ReturnType<typeof createTestSession>,
): SaveGenerationRequestV1<NoteSessionSnapshotV1> {
  const source = session.snapshot.source;
  if (source.kind !== "durable") throw new Error("Expected durable source.");
  return {
    generation: createSaveGeneration(1),
    coveredAttemptIds: [],
    coveredCheckpointIds: [],
    capture: () => ({
      sceneRevision: session.snapshot.scene.revision,
      snapshot: session.snapshot,
      sourceDigest: source.digest,
      sourceGeneration: source.generation,
    }),
  };
}

function failedPipeline(): SavePipeline<
  NoteSessionSnapshotV1,
  PreparedSidecarWrite
> {
  return {
    enqueue: async () => ({ kind: "failed" }),
    snapshot: {
      currentBase: {
        markdownPath: "notes/source.md",
        rawTextSha256: null,
        revision: null,
        vaultRelativePath: "notes/source.inkbook.json",
      },
    },
  } as unknown as SavePipeline<NoteSessionSnapshotV1, PreparedSidecarWrite>;
}

async function barrier(
  session: ReturnType<typeof createTestSession>,
): Promise<void> {
  await session.enqueue({
    kind: "lifecycle",
    retainedBytes: 0,
    run: (): void => undefined,
  });
}

describe("runtime persistence save failure handling", () => {
  it("publishes dirty and retains a transiently failed request", async () => {
    const session = createTestSession();
    const dirty = request(session);
    const retained: (typeof dirty)[] = [];

    enqueueRuntimeSaveV1({
      flushing: false,
      pipeline: failedPipeline(),
      request: dirty,
      retainForRetry: (value) => retained.push(value),
      session,
      setFlushSave: (): void => undefined,
    });
    await barrier(session);

    expect(session.snapshot.persistence).toEqual({
      generation: createSaveGeneration(1),
      kind: "dirty",
    });
    expect(retained).toEqual([dirty]);
  });

  it("retains a failed forced flush for retry", async () => {
    const session = createTestSession();
    const dirty = request(session);
    const retained: (typeof dirty)[] = [];
    let flushSave: Promise<unknown> = Promise.resolve();

    enqueueRuntimeSaveV1({
      flushing: true,
      pipeline: failedPipeline(),
      request: dirty,
      retainForRetry: (value) => retained.push(value),
      session,
      setFlushSave: (save): void => {
        flushSave = save;
      },
    });
    await flushSave;

    expect(retained).toEqual([dirty]);
  });

  it("restores recovery ids when the scheduler rejects dirty work", () => {
    const session = createTestSession();
    const attempt = parseRecoveryAttemptId("ra_00000000000000000000000001");
    const checkpoint = parseSourceCheckpointId(
      "scp_00000000000000000000000001",
    );
    const attempts = new Set([attempt]);
    const checkpoints = new Set([checkpoint]);
    const scheduler = {
      markDirty: () => "rejected",
    } as unknown as SaveStartScheduler<NoteSessionSnapshotV1>;

    const result = markRuntimeSaveDirtyV1({
      generation: createSaveGeneration(1),
      pendingAttempts: attempts,
      pendingCheckpoints: checkpoints,
      scheduler,
      session,
      source: session.snapshot.source as Extract<
        NoteSessionSnapshotV1["source"],
        { kind: "durable" }
      >,
    });

    expect(result).toBe("rejected");
    expect(attempts).toEqual(new Set([attempt]));
    expect(checkpoints).toEqual(new Set([checkpoint]));
  });
});
