/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact saga steps, bounds, and generations are the contract fixtures. */
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
  type NoteIdentityV1,
} from "../../../src/application/note-session";
import {
  RELOCATION_LIMITS_V1,
  beginFileRelocation,
  beginPrefixRelocation,
  canAdmitFirstSidecarCreation,
  resolveRelocatedPath,
  resumeFileRelocation,
  resumePrefixRelocation,
  type FileRelocationPortsV1,
  type PrefixRelocationPlanV1,
  type PrefixRelocationPortsV1,
  type PrefixRelocationRuleV1,
} from "../../../src/application/persistence/relocation";
import type {
  FileRelocationRecordV1,
  PrefixRelocationRecordV1,
} from "../../../src/application/recovery";
import { createRecoveryHarness } from "./saga-support";

const PAYLOAD = "00000000000000000000000000";
const NOTE: NoteIdentityV1 = {
  vaultIdHint: "vault",
  vaultRelativeMarkdownPath: "notes/source.md",
};
const BASE = {
  markdownPath: NOTE.vaultRelativeMarkdownPath,
  rawTextSha256: parseSha256Digest("a".repeat(64)),
  revision: createSidecarRevision(1),
  vaultRelativePath: "notes/source.inkbook.json",
};
const FILE_STEPS = [
  "sidecar-moved",
  "identities-rekeyed",
  "sidecar-metadata-saved",
  "marker-saved",
  "checkpoint-acknowledged",
  "complete",
] as const;

function fileRecord(
  kind: FileRelocationRecordV1["kind"] = "markdown-file",
): FileRelocationRecordV1 {
  return {
    destinationMarkdownPath:
      kind === "markdown-file" ? "notes/destination.md" : "notes/source.md",
    destinationSidecarPath: "annotations/notes/source.inkbook.json",
    expectedSceneRevision: createSceneRevision(1),
    expectedSettingsRevision: createSettingsRevision(1),
    kind,
    noteIdentity: NOTE,
    relocationId: parseRelocationId(`rel_${PAYLOAD}`),
    sidecarBase: BASE,
    sourceMarkdownPath: "notes/source.md",
    sourceSidecarPath: "notes/source.inkbook.json",
    step: "prepared",
  };
}

function prefixRecord(
  kind: PrefixRelocationRecordV1["kind"] = "folder-prefix",
): PrefixRelocationRecordV1 {
  return {
    admittedRecordCount: 3,
    cursor: 0,
    expectedSettingsRevision: createSettingsRevision(1),
    generation: 1,
    kind,
    priorPrefix: "notes",
    relocationId: parseRelocationId(`rel_${PAYLOAD}`),
    replacementPrefix: "archive",
    step: "prepared",
  };
}

function filePorts(log: string[]): FileRelocationPortsV1 {
  const record =
    (name: string): (() => Promise<CommandResultV1<void>>) =>
    async () => {
      log.push(name);
      return commandSuccess(undefined);
    };
  return {
    admitMutations: record("admit"),
    awaitSourceCheckpoint: record("checkpoint"),
    rekeyOwnedIdentities: record("rekey"),
    saveMarker: record("marker"),
    saveSidecarMetadata: record("metadata"),
    settleSaveAndMoveSidecar: record("move"),
  };
}

describe("file relocation application saga", () => {
  it("runs the durable file steps in exact order and rekeys recovery", async () => {
    const harness = createRecoveryHarness();
    const log: string[] = [];
    await expect(
      beginFileRelocation(fileRecord(), harness.store, filePorts(log)),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(log).toEqual([
      "move",
      "rekey",
      "metadata",
      "marker",
      "checkpoint",
      "admit",
    ]);
    expect(harness.relocations.size).toBe(0);
  });

  it("resumes after a persisted crash at every file step", async () => {
    for (const crashStep of FILE_STEPS) {
      const harness = createRecoveryHarness();
      const log: string[] = [];
      harness.crashAfterStep(crashStep);
      const started = await beginFileRelocation(
        fileRecord(),
        harness.store,
        filePorts(log),
      );
      expect(started).toEqual({ ok: false, code: "recovery-unavailable" });
      const durable = harness.relocations.values().next().value;
      if (durable?.kind !== "markdown-file") {
        throw new Error("Expected a durable file relocation.");
      }
      await expect(
        resumeFileRelocation(durable, harness.store, filePorts(log)),
      ).resolves.toEqual({ ok: true, value: undefined });
      expect(harness.relocations.size).toBe(0);
    }
  });

  it("retries an idempotent move after failure without advancing the record", async () => {
    const harness = createRecoveryHarness();
    let attempts = 0;
    const ports = filePorts([]);
    ports.settleSaveAndMoveSidecar = async (): Promise<
      CommandResultV1<void>
    > => {
      attempts += 1;
      return attempts === 1
        ? commandFailure("recovery-unavailable")
        : commandSuccess(undefined);
    };
    await expect(
      beginFileRelocation(fileRecord("sidecar-location"), harness.store, ports),
    ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });
    const durable = harness.relocations.values().next().value;
    if (durable?.kind !== "sidecar-location") {
      throw new Error("Expected a durable location relocation.");
    }
    await expect(
      resumeFileRelocation(durable, harness.store, ports),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(attempts).toBe(2);
  });
});

describe("prefix relocation and target-aware resolution", () => {
  it("persists root preparation and bounded cursor batches", async () => {
    const harness = createRecoveryHarness();
    const ranges: string[] = [];
    const ports: PrefixRelocationPortsV1 = {
      admitMutations: async (): Promise<CommandResultV1<void>> =>
        commandSuccess(undefined),
      loadOrPrepareDurablePlan: async (record) => {
        ranges.push(`prepare:${record.kind}`);
        return commandSuccess(plan(record));
      },
      processPlannedEntry: async (
        _record,
        _plan,
        ordinal,
      ): Promise<CommandResultV1<void>> => {
        ranges.push(`entry:${String(ordinal)}`);
        return commandSuccess(undefined);
      },
    };
    const first = await beginPrefixRelocation(
      prefixRecord("storage-root"),
      2,
      harness.store,
      ports,
    );
    expect(first).toMatchObject({ ok: true, value: { cursor: 2 } });
    if (!first.ok) throw new Error("Expected first prefix batch.");
    const second = await resumePrefixRelocation(
      first.value,
      2,
      harness.store,
      ports,
    );
    expect(second).toMatchObject({ ok: true, value: { cursor: 3 } });
    if (!second.ok) throw new Error("Expected second prefix batch.");
    const terminal = await resumePrefixRelocation(
      second.value,
      2,
      harness.store,
      ports,
    );
    if (!terminal.ok) throw new Error("Expected terminal prefix record.");
    await expect(
      resumePrefixRelocation(terminal.value, 2, harness.store, ports),
    ).resolves.toMatchObject({ ok: true });
    expect(ranges).toEqual([
      "prepare:storage-root",
      "entry:0",
      "entry:1",
      "prepare:storage-root",
      "entry:2",
      "prepare:storage-root",
    ]);
  });

  it("rejects the complete folder plan before the first range commit", async () => {
    const harness = createRecoveryHarness();
    let rangeCalls = 0;
    const record = prefixRecord("folder-prefix");
    const ports: PrefixRelocationPortsV1 = {
      admitMutations: async () => commandSuccess(undefined),
      loadOrPrepareDurablePlan: async () =>
        commandSuccess({
          ...plan(record),
          admittedRecordCount: record.admittedRecordCount - 1,
        }),
      processPlannedEntry: async () => {
        rangeCalls += 1;
        return commandSuccess(undefined);
      },
    };
    await expect(
      beginPrefixRelocation(record, 2, harness.store, ports),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    expect(rangeCalls).toBe(0);
    expect(harness.relocations.get(record.relocationId)).toEqual(record);
  });
});

describe("prefix relocation interruption handling", () => {
  it("persists one ordinal at a time and retries only the failed member", async () => {
    const harness = createRecoveryHarness();
    const calls: number[] = [];
    let failed = false;
    const ports: PrefixRelocationPortsV1 = {
      admitMutations: async () => commandSuccess(undefined),
      loadOrPrepareDurablePlan: async (record) => commandSuccess(plan(record)),
      processPlannedEntry: async (_record, _plan, ordinal) => {
        calls.push(ordinal);
        if (ordinal === 1 && !failed) {
          failed = true;
          return commandFailure("recovery-unavailable");
        }
        return commandSuccess(undefined);
      },
    };
    const record = prefixRecord();
    await expect(
      beginPrefixRelocation(record, 3, harness.store, ports),
    ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });
    const durable = harness.relocations.get(record.relocationId);
    if (durable?.kind !== "folder-prefix") {
      throw new Error("Expected durable folder relocation.");
    }
    expect(durable.cursor).toBe(1);
    await expect(
      resumePrefixRelocation(durable, 3, harness.store, ports),
    ).resolves.toMatchObject({ ok: true, value: { cursor: 3 } });
    expect(calls).toEqual([0, 1, 1, 2]);
  });

  it("resumes folder and root cursors after every durable step", async () => {
    for (const kind of ["folder-prefix", "storage-root"] as const) {
      for (const crashStep of ["processing", "complete"] as const) {
        const harness = createRecoveryHarness();
        const ports = prefixPorts();
        harness.crashAfterStep(crashStep);
        let interrupted = await beginPrefixRelocation(
          prefixRecord(kind),
          3,
          harness.store,
          ports,
        );
        if (interrupted.ok) {
          interrupted = await resumePrefixRelocation(
            interrupted.value,
            3,
            harness.store,
            ports,
          );
        }
        expect(interrupted).toEqual({
          ok: false,
          code: "recovery-unavailable",
        });
        const durable = harness.relocations.values().next().value;
        if (
          durable?.kind !== "folder-prefix" &&
          durable?.kind !== "storage-root"
        ) {
          throw new Error("Expected a durable prefix relocation.");
        }
        let current = durable;
        while (harness.relocations.size > 0) {
          const resumed = await resumePrefixRelocation(
            current,
            3,
            harness.store,
            ports,
          );
          if (!resumed.ok) {
            throw new Error("Expected resumed prefix relocation.");
          }
          current = resumed.value;
        }
        expect(harness.relocations.size).toBe(0);
      }
    }
  });
});

describe("first-sidecar relocation gate", () => {
  it("requires acknowledged policy state and no durable root saga", () => {
    expect(
      canAdmitFirstSidecarCreation({
        activeStorageRootRelocation: null,
        policyCreationBlocked: false,
      }),
    ).toBe(true);
    expect(
      canAdmitFirstSidecarCreation({
        activeStorageRootRelocation: prefixRecord("storage-root"),
        policyCreationBlocked: false,
      }),
    ).toBe(false);
    expect(
      canAdmitFirstSidecarCreation({
        activeStorageRootRelocation: null,
        policyCreationBlocked: true,
      }),
    ).toBe(false);
  });
});

describe("target-aware prefix resolution limits", () => {
  it("finds inverse and reused paths by generation with segment matching", () => {
    const rules = [
      rule(1, "a", "b", 1),
      rule(2, "b", "a", 2),
      rule(3, "a", "c", 3),
      rule(3, "a/nested", "wrong", 4),
    ];
    const resolved = resolveRelocatedPath("a/note.md", "c/note.md", rules);
    expect(resolved).toMatchObject({
      ok: true,
      value: {
        path: "c/note.md",
        relocationIds: [rules[2]?.relocationId],
      },
    });
    expect(resolveRelocatedPath("b/note.md", "a/note.md", rules)).toMatchObject(
      {
        ok: true,
        value: { relocationIds: [rules[1]?.relocationId] },
      },
    );
    expect(resolveRelocatedPath("ab/note.md", "c/note.md", rules)).toEqual({
      ok: false,
      code: "sidecar-conflict",
    });
  });

  it("fails closed at every resolver resource bound", () => {
    expect(RELOCATION_LIMITS_V1).toMatchObject({
      maxPrefixRules: 128,
      maxPrefixPlanMembers: 4096,
      maxResolverBytes: 1_048_576,
      maxResolverHops: 32,
      maxResolverStates: 4096,
      maxResolverTransitions: 8192,
    });
    const tooManyRules = Array.from({ length: 129 }, (_, index) =>
      rule(index + 1, `p${String(index)}`, `q${String(index)}`, index),
    );
    expect(
      resolveRelocatedPath("p0/a.md", "missing/a.md", tooManyRules),
    ).toEqual({
      ok: false,
      code: "invalid-command",
    });
    const longChain = Array.from({ length: 33 }, (_, index) =>
      rule(index + 1, `p${String(index)}`, `p${String(index + 1)}`, index),
    );
    expect(resolveRelocatedPath("p0/a.md", "p33/a.md", longChain)).toEqual({
      ok: false,
      code: "resource-limit",
    });
    const branching = Array.from({ length: 128 }, (_, index) =>
      rule(index + 1, "", "x", index),
    );
    expect(resolveRelocatedPath("a.md", "missing.md", branching)).toEqual({
      ok: false,
      code: "resource-limit",
    });
  });
});

function rule(
  generation: number,
  priorPrefix: string,
  replacementPrefix: string,
  identity: number,
): PrefixRelocationRuleV1 {
  return {
    generation,
    priorPrefix,
    relocationId: parseRelocationId(
      `rel_${identity.toString().padStart(26, "0")}`,
    ),
    replacementPrefix,
  };
}

function prefixPorts(): PrefixRelocationPortsV1 {
  const success = async (): Promise<CommandResultV1<void>> =>
    commandSuccess(undefined);
  return {
    admitMutations: success,
    loadOrPrepareDurablePlan: async (record) => commandSuccess(plan(record)),
    processPlannedEntry: async () => success(),
  };
}

function plan(record: PrefixRelocationRecordV1): PrefixRelocationPlanV1 {
  return {
    admittedRecordCount: record.admittedRecordCount,
    expectedSettingsRevision: record.expectedSettingsRevision,
    generation: record.generation,
    relocationId: record.relocationId,
  };
}
