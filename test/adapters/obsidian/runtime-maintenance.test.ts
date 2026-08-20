/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact migration bounds and revisions are contract fixtures. */
import { describe, expect, it } from "vitest";

import { RuntimeMaintenanceControllerV1 } from "../../../src/adapters/obsidian/runtime-maintenance";
import { OrphanSidecarReviewer } from "../../../src/adapters/obsidian/vault-sidecar/events";
import { VaultSidecarRelocator } from "../../../src/adapters/obsidian/vault-sidecar/relocation";
import {
  commandFailure,
  commandSuccess,
  createSettingsRevision,
  createSidecarRevision,
  parseRelocationId,
  parseSha256Digest,
  type CommandResultV1,
  type SettingsRevision,
} from "../../../src/application/note-session";
import type {
  FileRelocationPortsV1,
  StorageMigrationPreviewV1,
} from "../../../src/application/persistence";
import type { FileRelocationRecordV1 } from "../../../src/application/recovery";
import { createSceneRevision } from "../../../src/domain/model";
import { createRecoveryHarness } from "../../application/persistence/saga-support";
import { ControlledReviewScheduler, FakeVault } from "./vault-sidecar/support";

const SETTINGS_REVISION = createSettingsRevision(1);

describe("RuntimeMaintenanceControllerV1 migration", () => {
  it("previews without mutation and rejects collisions before confirmation", async () => {
    const vault = new FakeVault();
    const controller = createController(vault);
    const preview = controller.previewMigration({
      candidates: [
        { kind: "ready", record: migrationRecord(1) },
        {
          destinationSidecarPath: "Archive/collision.inkbook.json",
          kind: "collision",
          sourceSidecarPath: "Notes/collision.inkbook.json",
        },
      ],
      continuationRequired: false,
      destinationRoot: "Archive",
      settingsRevision: SETTINGS_REVISION,
      sourceRoot: "",
    });
    expect(preview).toMatchObject({
      ok: true,
      value: { candidateCount: 2, collisionCount: 1, readyCount: 1 },
    });
    if (!preview.ok) throw new Error("Expected a migration preview.");
    expect(controller.confirmMigration(preview.value)).toEqual({
      code: "sidecar-conflict",
      ok: false,
    });
    await expect(controller.resumeMigration(1)).resolves.toEqual({
      code: "invalid-command",
      ok: false,
    });
    expect(vault.renameCalls).toBe(0);
    expect(vault.getFilesCalls).toBe(0);
  });

  it("confirms against the current revision and runs a bounded relocation", async () => {
    const vault = new FakeVault();
    vault.addFile("Notes/note-1.inkbook.json", "{}");
    const controller = createController(vault);
    const preview = readyPreview(controller, migrationRecord(1));

    expect(controller.confirmMigration(preview)).toEqual({
      ok: true,
      value: { migratedFiles: 0, remainingFiles: 1, state: "progress" },
    });
    await expect(controller.resumeMigration(1)).resolves.toEqual({
      ok: true,
      value: { migratedFiles: 1, remainingFiles: 0, state: "complete" },
    });
    expect(vault.renameCalls).toBe(1);
    expect(
      vault.getFileByPath("Archive/Notes/note-1.inkbook.json"),
    ).not.toBeNull();
  });
});

describe("RuntimeMaintenanceControllerV1 migration recovery", () => {
  it("fails closed when a destination collision races the preview", async () => {
    const vault = new FakeVault();
    const source = vault.addFile("Notes/note-1.inkbook.json", "source");
    const controller = createController(vault);
    const preview = readyPreview(controller, migrationRecord(1));
    expect(controller.confirmMigration(preview).ok).toBe(true);
    const collision = vault.addFile(
      "Archive/Notes/note-1.inkbook.json",
      "external",
    );

    await expect(controller.resumeMigration(1)).resolves.toEqual({
      code: "sidecar-conflict",
      ok: false,
    });
    expect(vault.getFileByPath(source.path)).toBe(source);
    expect(vault.getFileByPath(collision.path)).toBe(collision);
    expect(vault.renameCalls).toBe(0);
  });

  it("rejects stale confirmation and supports explicit cancellation", () => {
    const vault = new FakeVault();
    const stale = createController(vault, createSettingsRevision(2));
    expect(
      stale.confirmMigration(readyPreview(stale, migrationRecord(1))),
    ).toEqual({
      code: "stale-source",
      ok: false,
    });

    const controller = createController(vault);
    expect(
      controller.confirmMigration(readyPreview(controller, migrationRecord(1)))
        .ok,
    ).toBe(true);
    expect(controller.cancelMigration()).toEqual({
      ok: true,
      value: { migratedFiles: 0, remainingFiles: 1, state: "cancelled" },
    });
  });

  it("resumes the exact durable storage-location relocation", async () => {
    const vault = new FakeVault();
    const source = vault.addFile("Notes/note-1.inkbook.json", "{}");
    const harness = createRecoveryHarness();
    const record = { ...migrationRecord(1), step: "sidecar-moved" } as const;
    harness.relocations.set(record.relocationId, record);
    const controller = new RuntimeMaintenanceControllerV1({
      orphanReviewer: new OrphanSidecarReviewer(
        vault,
        new ControlledReviewScheduler(),
      ),
      readSettingsRevision: (): SettingsRevision => SETTINGS_REVISION,
      recovery: harness.store,
      relocationPorts: relocationPorts(vault),
    });

    await expect(
      controller.resumeInterruptedMigration(record),
    ).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(vault.getFileByPath(source.path)).toBe(source);
    expect(harness.relocations.size).toBe(0);
  });
});

describe("RuntimeMaintenanceControllerV1 orphan review", () => {
  it("starts only explicitly and delegates bounded exact-suffix review", async () => {
    const vault = new FakeVault();
    vault.addFile("Visible.inkbook.json", "{}");
    vault.addFile("Backup.inkbook.json.bak", "{}");
    vault.addFile(".hidden/Hidden.inkbook.json", "{}");
    const controller = createController(vault);
    expect(vault.getFilesCalls).toBe(0);

    const result = await controller.reviewOrphans();

    expect(result).toMatchObject({
      kind: "complete",
      inspectedFiles: 3,
      requiresContinuation: false,
    });
    if (result.kind !== "complete") throw new Error("Expected orphan review.");
    expect(result.candidates.map((file) => file.path)).toEqual([
      "Visible.inkbook.json",
    ]);
    expect(vault.getFilesCalls).toBe(1);
  });

  it("continues from the exact bounded review cursor", async () => {
    const vault = new FakeVault();
    for (let index = 0; index < Number("10001"); index += 1) {
      vault.addFile(`Notes/${String(index)}.inkbook.json`, "{}");
    }
    const controller = createController(vault);
    const first = await controller.reviewOrphans();
    if (first.kind !== "complete" || first.continuation === null) {
      throw new Error("Expected orphan review continuation.");
    }

    const continued = await controller.continueOrphanReview(first.continuation);

    expect(continued).toMatchObject({
      continuation: null,
      inspectedFiles: 1,
      kind: "complete",
      requiresContinuation: false,
    });
    expect(vault.getFilesCalls).toBe(2);
  });
});

function createController(
  vault: FakeVault,
  settingsRevision = SETTINGS_REVISION,
): RuntimeMaintenanceControllerV1 {
  return new RuntimeMaintenanceControllerV1({
    orphanReviewer: new OrphanSidecarReviewer(
      vault,
      new ControlledReviewScheduler(),
    ),
    readSettingsRevision: () => settingsRevision,
    recovery: createRecoveryHarness().store,
    relocationPorts: relocationPorts(vault),
  });
}

function readyPreview(
  controller: RuntimeMaintenanceControllerV1,
  record: FileRelocationRecordV1,
): StorageMigrationPreviewV1 {
  const result = controller.previewMigration({
    candidates: [{ kind: "ready", record }],
    continuationRequired: false,
    destinationRoot: "Archive",
    settingsRevision: SETTINGS_REVISION,
    sourceRoot: "",
  });
  if (!result.ok) throw new Error("Expected a migration preview.");
  return result.value;
}

function migrationRecord(identity: number): FileRelocationRecordV1 {
  const name = `note-${String(identity)}`;
  const markdownPath = `Notes/${name}.md`;
  return {
    destinationMarkdownPath: markdownPath,
    destinationSidecarPath: `Archive/Notes/${name}.inkbook.json`,
    expectedSceneRevision: createSceneRevision(1),
    expectedSettingsRevision: SETTINGS_REVISION,
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
      vaultRelativePath: `Notes/${name}.inkbook.json`,
    },
    sourceMarkdownPath: markdownPath,
    sourceSidecarPath: `Notes/${name}.inkbook.json`,
    step: "prepared",
  };
}

function relocationPorts(vault: FakeVault): FileRelocationPortsV1 {
  const relocator = new VaultSidecarRelocator(vault);
  const success = async (): Promise<CommandResultV1<void>> =>
    commandSuccess(undefined);
  return {
    admitMutations: success,
    awaitSourceCheckpoint: success,
    rekeyOwnedIdentities: success,
    saveMarker: success,
    saveSidecarMetadata: success,
    settleSaveAndMoveSidecar: async (
      record,
    ): Promise<CommandResultV1<void>> => {
      const source = vault.getFileByPath(record.sourceSidecarPath);
      if (source === null || !("stat" in source)) {
        return commandFailure("sidecar-conflict");
      }
      const relocated = await relocator.relocate({
        destinationPath: record.destinationSidecarPath,
        relocationId: record.relocationId,
        sourceFile: source,
      });
      return relocated.kind === "acknowledged"
        ? commandSuccess(undefined)
        : commandFailure("sidecar-conflict");
    },
  };
}
