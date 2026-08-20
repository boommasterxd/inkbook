/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact revisions and durable IDs define migration records. */
import { describe, expect, it } from "vitest";

import {
  createRuntimeMaintenanceControllerV1,
  RuntimeMaintenanceControllerV1,
} from "../../../src/adapters/obsidian/runtime-maintenance";
import {
  createSettingsRevision,
  createSidecarRevision,
  parseRelocationId,
  parseSha256Digest,
} from "../../../src/application/note-session";
import type {
  FileRelocationPortsV1,
  SidecarStoragePolicyStoreV1,
  StorageMigrationPreviewV1,
} from "../../../src/application/persistence";
import type { FileRelocationRecordV1 } from "../../../src/application/recovery";
import { createSceneRevision } from "../../../src/domain/model";
import { createRecoveryHarness } from "../../application/persistence/saga-support";

const SETTINGS_REVISION = createSettingsRevision(1);
const STORAGE_POLICY = {
  snapshot: {
    policy: { mode: "adjacent", version: 1 },
    revision: SETTINGS_REVISION,
  },
} as unknown as SidecarStoragePolicyStoreV1;
const UNUSED_RELOCATION_PORTS = {} as FileRelocationPortsV1;
const REVIEWER = {
  review: async (): Promise<{
    readonly candidates: readonly [];
    readonly continuation: null;
    readonly inspectedFiles: number;
    readonly kind: "complete";
    readonly requiresContinuation: false;
  }> => ({
    candidates: [],
    continuation: null,
    inspectedFiles: 0,
    kind: "complete",
    requiresContinuation: false,
  }),
};

describe("runtime maintenance dependency boundaries", () => {
  it("remains unavailable until every maintenance capability is present", () => {
    const recovery = createRecoveryHarness().store;

    expect(
      createRuntimeMaintenanceControllerV1(
        null,
        UNUSED_RELOCATION_PORTS,
        STORAGE_POLICY,
        REVIEWER,
      ),
    ).toBeNull();
    expect(
      createRuntimeMaintenanceControllerV1(
        recovery,
        null,
        STORAGE_POLICY,
        REVIEWER,
      ),
    ).toBeNull();
    expect(
      createRuntimeMaintenanceControllerV1(
        recovery,
        UNUSED_RELOCATION_PORTS,
        STORAGE_POLICY,
      ),
    ).toBeNull();
    expect(
      createRuntimeMaintenanceControllerV1(
        recovery,
        UNUSED_RELOCATION_PORTS,
        STORAGE_POLICY,
        REVIEWER,
      ),
    ).toBeInstanceOf(RuntimeMaintenanceControllerV1);
  });

  it("rejects cancellation before a migration is confirmed", () => {
    const controller = createController();

    expect(controller.cancelMigration()).toEqual({
      code: "invalid-command",
      ok: false,
    });
  });
});

describe("runtime maintenance pending migration", () => {
  it("does not replace a migration that is already in progress", () => {
    const controller = createController();
    const first = preview(controller, migrationRecord("one"));
    const replacement = preview(controller, migrationRecord("two"));

    expect(controller.confirmMigration(first)).toMatchObject({ ok: true });
    expect(controller.confirmMigration(replacement)).toEqual({
      code: "relocation-pending",
      ok: false,
    });
  });
});

function createController(): RuntimeMaintenanceControllerV1 {
  return new RuntimeMaintenanceControllerV1({
    orphanReviewer: REVIEWER,
    readSettingsRevision: () => SETTINGS_REVISION,
    recovery: createRecoveryHarness().store,
    relocationPorts: UNUSED_RELOCATION_PORTS,
  });
}

function preview(
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
  if (!result.ok) throw new Error("Expected a valid migration preview.");
  return result.value;
}

function migrationRecord(name: string): FileRelocationRecordV1 {
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
      `rel_${name === "one" ? "1" : "2"}`.padEnd(30, "0"),
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
