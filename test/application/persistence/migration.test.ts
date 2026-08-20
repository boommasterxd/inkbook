/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact migration limits, revisions, and cursors are contract fixtures. */
import { describe, expect, it } from "vitest";

import { createSceneRevision } from "../../../src/domain/model";
import {
  commandFailure,
  commandSuccess,
} from "../../../src/application/note-session/results";
import {
  createSettingsRevision,
  createSidecarRevision,
  parseRelocationId,
  parseSha256Digest,
  type CommandResultV1,
} from "../../../src/application/note-session";
import {
  STORAGE_MIGRATION_LIMITS_V1,
  confirmStorageMigration,
  createStorageMigrationPreview,
  resumeStorageMigrationFile,
  type StorageMigrationPreviewV1,
  type StorageMigrationCandidateV1,
} from "../../../src/application/persistence/migration";
import type { FileRelocationPortsV1 } from "../../../src/application/persistence/relocation";
import type { FileRelocationRecordV1 } from "../../../src/application/recovery";
import { createRecoveryHarness, deferred } from "./saga-support";

const SETTINGS = createSettingsRevision(1);

function locationRecord(identity: number): FileRelocationRecordV1 {
  const name = `note-${String(identity)}`;
  const markdownPath = `notes/${name}.md`;
  return {
    destinationMarkdownPath: markdownPath,
    destinationSidecarPath: `annotations/notes/${name}.inkbook.json`,
    expectedSceneRevision: createSceneRevision(1),
    expectedSettingsRevision: SETTINGS,
    kind: "sidecar-location",
    noteIdentity: {
      vaultIdHint: "vault",
      vaultRelativeMarkdownPath: markdownPath,
    },
    relocationId: parseRelocationId(
      `rel_${identity.toString().padStart(26, "0")}`,
    ),
    sidecarBase: {
      markdownPath,
      rawTextSha256: parseSha256Digest("a".repeat(64)),
      revision: createSidecarRevision(1),
      vaultRelativePath: `notes/${name}.inkbook.json`,
    },
    sourceMarkdownPath: markdownPath,
    sourceSidecarPath: `notes/${name}.inkbook.json`,
    step: "prepared",
  };
}

function migrationPorts(
  move: (record: FileRelocationRecordV1) => Promise<CommandResultV1<void>>,
): FileRelocationPortsV1 {
  const success = async (): Promise<CommandResultV1<void>> =>
    commandSuccess(undefined);
  return {
    admitMutations: success,
    awaitSourceCheckpoint: success,
    rekeyOwnedIdentities: success,
    saveMarker: success,
    saveSidecarMetadata: success,
    settleSaveAndMoveSidecar: move,
  };
}

function preview(
  candidates: readonly StorageMigrationCandidateV1[],
): CommandResultV1<StorageMigrationPreviewV1> {
  return createStorageMigrationPreview({
    candidates,
    continuationRequired: false,
    destinationRoot: "annotations",
    settingsRevision: SETTINGS,
    sourceRoot: "",
  });
}

describe("explicit storage migration", () => {
  it("previews ready files, collisions, unsupported paths, and continuation", () => {
    const result = createStorageMigrationPreview({
      candidates: [
        { kind: "ready", record: locationRecord(1) },
        {
          destinationSidecarPath: "annotations/collision.inkbook.json",
          kind: "collision",
          sourceSidecarPath: "notes/collision.inkbook.json",
        },
        {
          kind: "unsupported",
          sourceSidecarPath: "notes/unsupported.inkbook.json",
        },
      ],
      continuationRequired: true,
      destinationRoot: "annotations",
      settingsRevision: SETTINGS,
      sourceRoot: "",
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        candidateCount: 3,
        collisionCount: 1,
        continuationRequired: true,
        estimatedFileOperations: 1,
        readyCount: 1,
        unsupportedCount: 1,
      },
    });
    expect(STORAGE_MIGRATION_LIMITS_V1).toEqual({
      maxCandidates: 10_000,
      maxFilesPerBatch: 512,
    });
  });

  it("requires explicit confirmation against the previewed settings revision", () => {
    const result = preview([{ kind: "ready", record: locationRecord(1) }]);
    if (!result.ok) throw new Error("Expected migration preview.");
    const harness = createRecoveryHarness();
    expect(
      confirmStorageMigration({
        expectedSettingsRevision: createSettingsRevision(2),
        ports: migrationPorts(async () => commandSuccess(undefined)),
        preview: result.value,
        recovery: harness.store,
      }),
    ).toEqual({ ok: false, code: "stale-source" });
  });

  it("rejects a forged preview with an invalid ready record", () => {
    const result = preview([{ kind: "ready", record: locationRecord(1) }]);
    if (!result.ok) throw new Error("Expected migration preview.");
    const harness = createRecoveryHarness();
    expect(
      confirmStorageMigration({
        expectedSettingsRevision: SETTINGS,
        ports: migrationPorts(async () => commandSuccess(undefined)),
        preview: {
          ...result.value,
          readyRecords: [
            { ...locationRecord(1), destinationMarkdownPath: "other.md" },
          ],
        },
        recovery: harness.store,
      }),
    ).toEqual({ ok: false, code: "invalid-command" });
  });

  it("cancels only after the active file reaches its terminal step", async () => {
    const result = preview([
      { kind: "ready", record: locationRecord(1) },
      { kind: "ready", record: locationRecord(2) },
    ]);
    if (!result.ok) throw new Error("Expected migration preview.");
    const harness = createRecoveryHarness();
    const move = deferred<ReturnType<typeof commandSuccess<void>>>();
    let moveCalls = 0;
    const confirmed = confirmStorageMigration({
      expectedSettingsRevision: SETTINGS,
      ports: migrationPorts(async () => {
        moveCalls += 1;
        return moveCalls === 1 ? move.promise : commandSuccess(undefined);
      }),
      preview: result.value,
      recovery: harness.store,
    });
    if (!confirmed.ok) throw new Error("Expected confirmed migration.");
    const running = confirmed.value.runBatch(2);
    confirmed.value.cancel();
    move.resolve(commandSuccess(undefined));
    await expect(running).resolves.toEqual({
      ok: true,
      value: { migratedFiles: 1, remainingFiles: 1, state: "cancelled" },
    });
    expect(moveCalls).toBe(1);
  });
});

describe("storage migration interruption handling", () => {
  it("fails closed on a raced collision without beginning the next file", async () => {
    const result = preview([
      { kind: "ready", record: locationRecord(1) },
      { kind: "ready", record: locationRecord(2) },
    ]);
    if (!result.ok) throw new Error("Expected migration preview.");
    const harness = createRecoveryHarness();
    let calls = 0;
    const confirmed = confirmStorageMigration({
      expectedSettingsRevision: SETTINGS,
      ports: migrationPorts(async () => {
        calls += 1;
        return commandFailure("sidecar-conflict");
      }),
      preview: result.value,
      recovery: harness.store,
    });
    if (!confirmed.ok) throw new Error("Expected confirmed migration.");
    await expect(confirmed.value.runBatch(2)).resolves.toEqual({
      ok: false,
      code: "sidecar-conflict",
    });
    expect(calls).toBe(1);
    expect(confirmed.value.progress()).toEqual({
      migratedFiles: 0,
      remainingFiles: 2,
      state: "progress",
    });
  });

  it("resumes the exact durable file after an interrupted metadata step", async () => {
    const harness = createRecoveryHarness();
    harness.crashAfterStep("sidecar-metadata-saved");
    const result = preview([{ kind: "ready", record: locationRecord(1) }]);
    if (!result.ok) throw new Error("Expected migration preview.");
    const ports = migrationPorts(async () => commandSuccess(undefined));
    const confirmed = confirmStorageMigration({
      expectedSettingsRevision: SETTINGS,
      ports,
      preview: result.value,
      recovery: harness.store,
    });
    if (!confirmed.ok) throw new Error("Expected confirmed migration.");
    await expect(confirmed.value.runBatch(1)).resolves.toEqual({
      ok: false,
      code: "recovery-unavailable",
    });
    const durable = harness.relocations.values().next().value;
    if (durable?.kind !== "sidecar-location") {
      throw new Error("Expected durable storage migration.");
    }
    await expect(
      resumeStorageMigrationFile(durable, harness.store, ports),
    ).resolves.toEqual({ ok: true, value: undefined });
  });
});
