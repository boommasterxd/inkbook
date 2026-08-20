/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact revisions and conflict-copy limits are contract fixtures. */
import { describe, expect, it } from "vitest";

import { createSceneRevision } from "../../../src/domain/model";
import {
  commandFailure,
  commandSuccess,
} from "../../../src/application/note-session/results";
import {
  createSettingsRevision,
  createSidecarRevision,
  createSourceGeneration,
  parseRelocationId,
  parseSha256Digest,
  type CommandResultV1,
  type NoteIdentityV1,
} from "../../../src/application/note-session";
import {
  ExternalSidecarChangeCoordinatorV1,
  conflictCopyPath,
  type ExternalSidecarConflictV1,
  type ExternalSidecarPortsV1,
} from "../../../src/application/persistence/external-change";
import type {
  FileRelocationRecordV1,
  RecoveryLoadRequestV1,
  SidecarBaseIdentityV1,
} from "../../../src/application/recovery";
import { createRecoveryHarness } from "./saga-support";

const PAYLOAD = "00000000000000000000000000";
const NOTE: NoteIdentityV1 = {
  vaultIdHint: "vault",
  vaultRelativeMarkdownPath: "notes/note.md",
};
const BASE: SidecarBaseIdentityV1 = {
  markdownPath: NOTE.vaultRelativeMarkdownPath,
  rawTextSha256: parseSha256Digest("a".repeat(64)),
  revision: createSidecarRevision(1),
  vaultRelativePath: "notes/note.inkbook.json",
};
const EXTERNAL_BASE: SidecarBaseIdentityV1 = {
  ...BASE,
  rawTextSha256: parseSha256Digest("b".repeat(64)),
  revision: createSidecarRevision(2),
};

function recoveryLoad(): RecoveryLoadRequestV1 {
  const markdownDigest = parseSha256Digest("c".repeat(64));
  return {
    base: BASE,
    currentMarkdownDigest: markdownDigest,
    currentMarkdownUtf16Length: 10,
    kind: "existing-sidecar",
    noteIdentity: NOTE,
    validatedSidecarSourceDigest: markdownDigest,
    validatedSidecarSourceGeneration: createSourceGeneration(1),
  };
}

function ports(log: string[]): ExternalSidecarPortsV1 {
  const success =
    (name: string): (() => Promise<CommandResultV1<void>>) =>
    async () => {
      log.push(name);
      return commandSuccess(undefined);
    };
  return {
    createConflictCopyIfAbsent: async (
      request,
    ): Promise<CommandResultV1<void>> => {
      log.push(
        `copy:${request.destinationPath}:${String(request.maximumExistingCopies)}`,
      );
      return commandSuccess(undefined);
    },
    prepareExternalReload: async (): Promise<
      CommandResultV1<{
        token: string;
        validatedExternalBase: SidecarBaseIdentityV1;
      }>
    > => {
      log.push("prepare-reload");
      return commandSuccess({
        token: "reload-token",
        validatedExternalBase: EXTERNAL_BASE,
      });
    },
    publishConflict: success("conflict"),
    publishMissingDrift: success("drift"),
    publishExternalReload: success("reload"),
    remainReadOnly: success("read-only"),
  };
}

describe("external sidecar write decisions", () => {
  it("publishes exact-path create and modify conflicts while preserving recovery", async () => {
    for (const kind of ["create", "modify"] as const) {
      const harness = createRecoveryHarness();
      const relocation = fileRelocation();
      await harness.store.beginRelocation(relocation);
      const log: string[] = [];
      const coordinator = new ExternalSidecarChangeCoordinatorV1(
        harness.store,
        ports(log),
      );
      const result = await coordinator.observe({
        activeRelocation: null,
        event: {
          kind,
          observedBase: EXTERNAL_BASE,
          path: BASE.vaultRelativePath,
        },
        expectedBase: BASE,
        noteIdentity: NOTE,
        recoveryLoadRequest: recoveryLoad(),
      });
      expect(result).toMatchObject({ ok: true, value: { kind: "conflict" } });
      expect(log).toEqual(["conflict"]);
      expect(harness.relocations.get(relocation.relocationId)).toEqual(
        relocation,
      );
    }
  });

  it("ignores current and unrelated writes without publishing state", async () => {
    const harness = createRecoveryHarness();
    const log: string[] = [];
    const coordinator = new ExternalSidecarChangeCoordinatorV1(
      harness.store,
      ports(log),
    );
    const current = await coordinator.observe({
      activeRelocation: null,
      event: {
        kind: "modify",
        observedBase: BASE,
        path: BASE.vaultRelativePath,
      },
      expectedBase: BASE,
      noteIdentity: NOTE,
      recoveryLoadRequest: recoveryLoad(),
    });
    const unrelated = await coordinator.observe({
      activeRelocation: null,
      event: {
        kind: "create",
        observedBase: {
          ...EXTERNAL_BASE,
          vaultRelativePath: "other.inkbook.json",
        },
        path: "other.inkbook.json",
      },
      expectedBase: BASE,
      noteIdentity: NOTE,
      recoveryLoadRequest: recoveryLoad(),
    });
    expect(current).toMatchObject({ ok: true, value: { kind: "current" } });
    expect(unrelated).toMatchObject({ ok: true, value: { kind: "unrelated" } });
    expect(log).toEqual([]);
  });
});

describe("external sidecar conflict choices", () => {
  it("requires confirmation for reload and keeps cancel read-only", async () => {
    const { conflict, coordinator, log } = await conflictHarness();
    await expect(
      coordinator.resolve(conflict, {
        confirmedDiscardUnsaved: false,
        kind: "reload",
      }),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });
    await expect(
      coordinator.resolve(conflict, { kind: "cancel-read-only" }),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(log).toEqual(["conflict", "read-only"]);
  });

  it("creates a bounded collision-safe copy before confirmed reload", async () => {
    const { conflict, coordinator, log } = await conflictHarness();
    await expect(
      coordinator.resolve(conflict, {
        kind: "conflict-copy",
        suffix: "0123ABCD",
        utcBasicTimestamp: "20260820T170000Z",
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(log).toEqual([
      "conflict",
      "copy:notes/note.inkbook.conflict-20260820T170000Z-0123ABCD.json:3",
      "prepare-reload",
      "reload",
    ]);
  });

  it("retains conflict when create-if-absent reports a collision", async () => {
    const harness = createRecoveryHarness();
    const log: string[] = [];
    const failing = ports(log);
    failing.createConflictCopyIfAbsent = async (): Promise<
      CommandResultV1<void>
    > => {
      log.push("copy-collision");
      return commandFailure("sidecar-conflict");
    };
    const coordinator = new ExternalSidecarChangeCoordinatorV1(
      harness.store,
      failing,
    );
    const conflict = await observedConflict(coordinator);
    await expect(
      coordinator.resolve(conflict, {
        kind: "conflict-copy",
        suffix: "0123ABCD",
        utcBasicTimestamp: "20260820T170000Z",
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    expect(log).toEqual(["conflict", "copy-collision"]);
  });

  it("fails closed when the external base changes again before reload", async () => {
    const harness = createRecoveryHarness();
    const log: string[] = [];
    const raced = ports(log);
    raced.prepareExternalReload = async (): Promise<CommandResultV1<never>> => {
      log.push("reload-raced");
      return commandFailure("sidecar-conflict");
    };
    const coordinator = new ExternalSidecarChangeCoordinatorV1(
      harness.store,
      raced,
    );
    const conflict = await observedConflict(coordinator);
    await expect(
      coordinator.resolve(conflict, {
        confirmedDiscardUnsaved: true,
        kind: "reload",
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    expect(log).toEqual(["conflict", "reload-raced"]);
  });
});

describe("confirmed external reload recovery CAS", () => {
  it("does not publish reload when durable recovery changed after the modal", async () => {
    const harness = createRecoveryHarness();
    const relocation = fileRelocation();
    await harness.store.beginRelocation(relocation);
    const log: string[] = [];
    const coordinator = new ExternalSidecarChangeCoordinatorV1(
      harness.store,
      ports(log),
    );
    const conflict = await observedConflict(coordinator);
    await expect(
      coordinator.resolve(conflict, {
        confirmedDiscardUnsaved: true,
        kind: "reload",
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    expect(log).toEqual(["conflict", "prepare-reload"]);
    expect(harness.relocations.get(relocation.relocationId)).toEqual(
      relocation,
    );
  });
});

describe("external sidecar rename and delete decisions", () => {
  it("publishes missing drift without clearing durable recovery", async () => {
    for (const event of [
      { kind: "delete", path: BASE.vaultRelativePath } as const,
      {
        kind: "rename",
        newPath: "archive/note.inkbook.json",
        oldPath: BASE.vaultRelativePath,
        ownedRelocationId: null,
      } as const,
    ]) {
      const harness = createRecoveryHarness();
      const relocation = fileRelocation();
      await harness.store.beginRelocation(relocation);
      const log: string[] = [];
      const coordinator = new ExternalSidecarChangeCoordinatorV1(
        harness.store,
        ports(log),
      );
      const result = await coordinator.observe({
        activeRelocation: null,
        event,
        expectedBase: BASE,
        noteIdentity: NOTE,
        recoveryLoadRequest: recoveryLoad(),
      });
      expect(result).toMatchObject({
        ok: true,
        value: { kind: "missing-drift" },
      });
      expect(log).toEqual(["drift"]);
      expect(harness.relocations.get(relocation.relocationId)).toEqual(
        relocation,
      );
    }
  });

  it("filters an exact owned rename once and routes duplicates to drift", async () => {
    const harness = createRecoveryHarness();
    const log: string[] = [];
    const relocation = fileRelocation();
    const coordinator = new ExternalSidecarChangeCoordinatorV1(
      harness.store,
      ports(log),
    );
    const observation = {
      activeRelocation: relocation,
      event: {
        kind: "rename" as const,
        newPath: relocation.destinationSidecarPath,
        oldPath: relocation.sourceSidecarPath,
        ownedRelocationId: relocation.relocationId,
      },
      expectedBase: BASE,
      noteIdentity: NOTE,
      recoveryLoadRequest: recoveryLoad(),
    };
    await expect(coordinator.observe(observation)).resolves.toMatchObject({
      ok: true,
      value: { kind: "owned-relocation" },
    });
    await expect(coordinator.observe(observation)).resolves.toMatchObject({
      ok: true,
      value: { kind: "missing-drift" },
    });
    expect(log).toEqual(["drift"]);
  });
});

describe("owned sidecar rename identity failures", () => {
  it("routes mismatched and late ownership claims through external drift", async () => {
    for (const activeRelocation of [fileRelocation(), null]) {
      const harness = createRecoveryHarness();
      const log: string[] = [];
      const relocation = fileRelocation();
      const coordinator = new ExternalSidecarChangeCoordinatorV1(
        harness.store,
        ports(log),
      );
      const result = await coordinator.observe({
        activeRelocation,
        event: {
          kind: "rename",
          newPath: relocation.destinationSidecarPath,
          oldPath: relocation.sourceSidecarPath,
          ownedRelocationId:
            activeRelocation === null
              ? relocation.relocationId
              : parseRelocationId("rel_00000000000000000000000001"),
        },
        expectedBase: BASE,
        noteIdentity: NOTE,
        recoveryLoadRequest: recoveryLoad(),
      });
      expect(result).toMatchObject({
        ok: true,
        value: { kind: "missing-drift" },
      });
      expect(log).toEqual(["drift"]);
    }
  });
});

describe("conflict-copy paths", () => {
  it("accepts only normalized canonical conflict-copy components", () => {
    expect(
      conflictCopyPath(BASE.vaultRelativePath, "20260820T170000Z", "0123ABCD"),
    ).toEqual({
      ok: true,
      value: "notes/note.inkbook.conflict-20260820T170000Z-0123ABCD.json",
    });
    expect(
      conflictCopyPath(BASE.vaultRelativePath, "2026-08-20", "invalid!"),
    ).toEqual({ ok: false, code: "invalid-command" });
  });
});

async function conflictHarness(): Promise<{
  conflict: ExternalSidecarConflictV1;
  coordinator: ExternalSidecarChangeCoordinatorV1;
  log: string[];
}> {
  const harness = createRecoveryHarness();
  const log: string[] = [];
  const coordinator = new ExternalSidecarChangeCoordinatorV1(
    harness.store,
    ports(log),
  );
  return { conflict: await observedConflict(coordinator), coordinator, log };
}

async function observedConflict(
  coordinator: ExternalSidecarChangeCoordinatorV1,
): Promise<ExternalSidecarConflictV1> {
  const observed = await coordinator.observe({
    activeRelocation: null,
    event: {
      kind: "modify",
      observedBase: EXTERNAL_BASE,
      path: BASE.vaultRelativePath,
    },
    expectedBase: BASE,
    noteIdentity: NOTE,
    recoveryLoadRequest: recoveryLoad(),
  });
  if (!observed.ok || observed.value.kind !== "conflict") {
    throw new Error("Expected external sidecar conflict.");
  }
  return observed.value.conflict;
}

function fileRelocation(): FileRelocationRecordV1 {
  return {
    destinationMarkdownPath: "archive/note.md",
    destinationSidecarPath: "archive/note.inkbook.json",
    expectedSceneRevision: createSceneRevision(1),
    expectedSettingsRevision: createSettingsRevision(1),
    kind: "markdown-file",
    noteIdentity: NOTE,
    relocationId: parseRelocationId(`rel_${PAYLOAD}`),
    sidecarBase: BASE,
    sourceMarkdownPath: NOTE.vaultRelativeMarkdownPath,
    sourceSidecarPath: BASE.vaultRelativePath,
    step: "prepared",
  };
}
