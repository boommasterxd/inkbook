/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact relocation cursors and revisions are contract fixtures. */
import { describe, expect, it } from "vitest";

import {
  commandFailure,
  commandSuccess,
} from "../../../src/application/note-session/results";
import {
  createSettingsRevision,
  parseRelocationId,
  type CommandResultV1,
} from "../../../src/application/note-session";
import {
  beginPrefixRelocation,
  canAdmitFirstSidecarCreation,
  resumePrefixRelocation,
  type PrefixRelocationPlanV1,
  type PrefixRelocationPortsV1,
} from "../../../src/application/persistence/relocation";
import { SidecarStoragePolicyStoreV1 } from "../../../src/application/persistence/storage-policy";
import type { PrefixRelocationRecordV1 } from "../../../src/application/recovery";
import { createRecoveryHarness } from "./saga-support";

const RECORD: PrefixRelocationRecordV1 = {
  admittedRecordCount: 2,
  cursor: 0,
  expectedSettingsRevision: createSettingsRevision(1),
  generation: 1,
  kind: "storage-root",
  priorPrefix: "annotations",
  relocationId: parseRelocationId("rel_00000000000000000000000000"),
  replacementPrefix: "archive/annotations",
  step: "prepared",
};

function plan(record: PrefixRelocationRecordV1): PrefixRelocationPlanV1 {
  return {
    admittedRecordCount: record.admittedRecordCount,
    expectedSettingsRevision: record.expectedSettingsRevision,
    generation: record.generation,
    relocationId: record.relocationId,
  };
}

function successfulPorts(): PrefixRelocationPortsV1 {
  const success = async (): Promise<CommandResultV1<void>> =>
    commandSuccess(undefined);
  return {
    admitMutations: success,
    loadOrPrepareDurablePlan: async (record) => commandSuccess(plan(record)),
    processPlannedEntry: success,
  };
}

describe("storage-root relocation creation gate", () => {
  it("rejects an over-limit plan before persisting the saga", async () => {
    const harness = createRecoveryHarness();
    await expect(
      beginPrefixRelocation(
        { ...RECORD, admittedRecordCount: 4097 },
        2,
        harness.store,
        successfulPorts(),
      ),
    ).resolves.toEqual({ ok: false, code: "resource-limit" });
    expect(harness.relocations.size).toBe(0);
  });

  it("survives failed policy persistence and blocks restart until completion", async () => {
    const harness = createRecoveryHarness();
    const policy = new SidecarStoragePolicyStoreV1({
      saveData: async (): Promise<void> => {
        throw new Error("saveData failed");
      },
    });
    await expect(
      policy.setPolicy({
        mode: "vault-root",
        vaultRelativeRoot: RECORD.replacementPrefix,
        version: 1,
      }),
    ).resolves.toMatchObject({ status: "retry-required" });
    const failedPorts = successfulPorts();
    failedPorts.loadOrPrepareDurablePlan = async (): Promise<
      CommandResultV1<PrefixRelocationPlanV1>
    > => commandFailure("recovery-unavailable");
    await expect(
      beginPrefixRelocation(RECORD, 2, harness.store, failedPorts),
    ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });
    const durable = harness.relocations.get(RECORD.relocationId);
    if (durable?.kind !== "storage-root") {
      throw new Error("Expected durable storage-root relocation.");
    }
    expect(
      canAdmitFirstSidecarCreation({
        activeStorageRootRelocation: durable,
        policyCreationBlocked: !policy.canCreateSidecar,
      }),
    ).toBe(false);
    expect(
      canAdmitFirstSidecarCreation({
        activeStorageRootRelocation: durable,
        policyCreationBlocked: false,
      }),
    ).toBe(false);

    const ports = successfulPorts();
    const processed = await resumePrefixRelocation(
      durable,
      2,
      harness.store,
      ports,
    );
    if (!processed.ok) throw new Error("Expected root entries to resume.");
    const terminal = await resumePrefixRelocation(
      processed.value,
      2,
      harness.store,
      ports,
    );
    if (!terminal.ok) throw new Error("Expected terminal root record.");
    await expect(
      resumePrefixRelocation(terminal.value, 2, harness.store, ports),
    ).resolves.toEqual({ ok: true, value: terminal.value });
    expect(harness.relocations.size).toBe(0);
    expect(
      canAdmitFirstSidecarCreation({
        activeStorageRootRelocation: null,
        policyCreationBlocked: false,
      }),
    ).toBe(true);
  });
});
