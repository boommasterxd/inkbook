import { describe, expect, it } from "vitest";

import {
  commandSuccess,
  createSettingsRevision,
  parseRelocationId,
  type NoteSessionRegistryV1,
} from "../../../src/application/note-session";
import {
  canAdmitFirstSidecarCreation,
  SidecarStoragePolicyStoreV1,
  type SidecarStoragePolicyLoadResultV1,
} from "../../../src/application/persistence";
import type {
  PrefixRelocationRecordV1,
  RecoveryStore,
} from "../../../src/application/recovery";
import { RuntimeRelocationControllerV1 } from "../../../src/adapters/obsidian/runtime-relocation";
import { SidecarMarkerWriter } from "../../../src/adapters/obsidian/vault-sidecar/marker";
import { VaultSidecarRelocator } from "../../../src/adapters/obsidian/vault-sidecar/relocation";
import {
  createRecoveryHarness,
  deferred,
} from "../../application/persistence/saga-support";
import { FakeFrontMatterHost, FakeVault } from "./vault-sidecar/support";

const PRIOR_ROOT = "Annotations";
const REPLACEMENT_ROOT = "Archive";

describe("RuntimeRelocationControllerV1 storage-root crash windows", () => {
  it("persists the prepared root relocation before saveData acknowledgement", async () => {
    const recovery = restartableRecovery();
    const saveStarted = deferred<undefined>();
    const saveAcknowledged = deferred<undefined>();
    const policy = storagePolicy(async () => {
      saveStarted.resolve(undefined);
      await saveAcknowledged.promise;
    });
    const controller = relocationController(recovery, policy);

    const pending = controller.acceptFolderRename(
      PRIOR_ROOT,
      REPLACEMENT_ROOT,
      "vault",
    );
    await saveStarted.promise;

    const durable = activeRoot(recovery.records);
    expect(durable).toMatchObject({ kind: "storage-root", step: "prepared" });
    expect(controller.activeStorageRootRelocation).toEqual(durable);
    saveAcknowledged.resolve(undefined);
    await pending;
    await controller.dispose();
  });

  it("keeps the restart creation gate closed after saveData failure", async () => {
    const recovery = restartableRecovery();
    const first = relocationController(recovery, failingPolicy());
    await first.acceptFolderRename(PRIOR_ROOT, REPLACEMENT_ROOT, "vault");
    expect(activeRoot(recovery.records).step).toBe("prepared");

    const restartPolicy = failingPolicy();
    const restarted = relocationController(recovery, restartPolicy);
    await restarted.resumeActive();

    expect(restarted.activeStorageRootRelocation).not.toBeNull();
    expect(
      canAdmitFirstSidecarCreation({
        activeStorageRootRelocation: restarted.activeStorageRootRelocation,
        policyCreationBlocked: !restartPolicy.canCreateSidecar,
      }),
    ).toBe(false);
    await first.dispose();
    await restarted.dispose();
  });

  it("resumes the durable root relocation after restart and policy acknowledgement", async () => {
    const recovery = restartableRecovery();
    const first = relocationController(recovery, failingPolicy());
    await first.acceptFolderRename(PRIOR_ROOT, REPLACEMENT_ROOT, "vault");
    const restartPolicy = storagePolicy(async () => undefined);
    const restarted = relocationController(recovery, restartPolicy);

    await restarted.resumeActive();

    expect(restarted.activeStorageRootRelocation).toBeNull();
    expect(activeRoot(recovery.records).step).toBe("complete");
    expect(restartPolicy.snapshot.policy).toEqual({
      mode: "vault-root",
      vaultRelativeRoot: REPLACEMENT_ROOT,
      version: 1,
    });
    await first.dispose();
    await restarted.dispose();
  });

  it("clears the creation gate only after successful root completion", async () => {
    const recovery = restartableRecovery();
    const policy = storagePolicy(async () => undefined);
    const controller = relocationController(recovery, policy);

    await controller.acceptFolderRename(PRIOR_ROOT, REPLACEMENT_ROOT, "vault");

    expect(controller.activeStorageRootRelocation).toBeNull();
    expect(recovery.records.size).toBe(0);
    expect(
      canAdmitFirstSidecarCreation({
        activeStorageRootRelocation: controller.activeStorageRootRelocation,
        policyCreationBlocked: !policy.canCreateSidecar,
      }),
    ).toBe(true);
    await controller.dispose();
  });
});

interface RestartableRecoveryV1 {
  readonly records: Map<string, PrefixRelocationRecordV1>;
  readonly store: RecoveryStore;
}

function restartableRecovery(): RestartableRecoveryV1 {
  const harness = createRecoveryHarness();
  const records = harness.relocations as Map<string, PrefixRelocationRecordV1>;
  return {
    records,
    store: {
      ...harness.store,
      loadActivePrefixRelocations: async () =>
        commandSuccess([...records.values()]),
    },
  };
}

function storagePolicy(
  saveData: (value: unknown) => Promise<void>,
): SidecarStoragePolicyStoreV1 {
  const loaded: SidecarStoragePolicyLoadResultV1 = {
    snapshot: {
      policy: {
        mode: "vault-root",
        vaultRelativeRoot: PRIOR_ROOT,
        version: 1,
      },
      revision: createSettingsRevision(1),
      version: 1,
    },
    status: "loaded",
  };
  return new SidecarStoragePolicyStoreV1({ saveData }, loaded);
}

function failingPolicy(): SidecarStoragePolicyStoreV1 {
  return storagePolicy(async () => {
    throw new Error("saveData failed");
  });
}

function relocationController(
  recovery: RestartableRecoveryV1,
  storagePolicy: SidecarStoragePolicyStoreV1,
): RuntimeRelocationControllerV1 {
  const vault = new FakeVault();
  return new RuntimeRelocationControllerV1({
    createRelocationId: () =>
      parseRelocationId("rel_00000000000000000000000000"),
    marker: new SidecarMarkerWriter(new FakeFrontMatterHost({})),
    owners: () => [],
    publishRelocationState: async () => commandSuccess(undefined),
    readSettingsRevision: () => storagePolicy.snapshot.revision,
    recovery: recovery.store,
    registry: emptyRegistry(),
    relocator: new VaultSidecarRelocator(vault),
    resolveMarkdownFile: () => null,
    storagePolicy,
  });
}

function emptyRegistry(): NoteSessionRegistryV1 {
  return {
    identitiesWithinPrefix: () => [],
  } as unknown as NoteSessionRegistryV1;
}

function activeRoot(
  records: ReadonlyMap<string, PrefixRelocationRecordV1>,
): PrefixRelocationRecordV1 {
  const record = [...records.values()][0];
  if (record === undefined)
    throw new Error("Expected durable root relocation.");
  return record;
}
