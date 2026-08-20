/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact revisions, limits, and durable IDs are contract fixtures. */
import { describe, expect, it } from "vitest";
import { TFile, TFolder } from "obsidian";

import {
  commandFailure,
  commandSuccess,
  createSettingsRevision,
  createSidecarRevision,
  createSourceGeneration,
  parseRelocationId,
  parseSha256Digest,
  type CommandResultV1,
  type NoteIdentityV1,
} from "../../../src/application/note-session";
import {
  createPersistenceEncodeWorkV1,
  PersistenceDecodedBytePoolV1,
  SIDECAR_RESOURCE_LIMITS_V1,
  type InkbookSidecarV1,
  type PersistenceCodecPortV1,
  type PersistenceCodecSubmissionV1,
  type PersistenceCodecWorkV1,
} from "../../../src/application/persistence";
import type {
  FileRelocationRecordV1,
  RecoveryStore,
  SidecarBaseIdentityV1,
} from "../../../src/application/recovery";
import { createStreamingSha256PortV1 } from "../../../src/application/source-coordination";
import type {
  SourceDigestWorkPortV1,
  SourceDigestWorkSubmissionV1,
} from "../../../src/application/source-coordination/work-ports";
import {
  bindRuntimeExternalSidecarChangeV1,
  RuntimeExternalSidecarChangeV1,
  type RuntimeExternalChangeBindingPortsV1,
  type RuntimeExternalChangeContextV1,
} from "../../../src/adapters/obsidian/runtime-external-change";
import { createSceneRevision } from "../../../src/domain/model";
import {
  completeSidecar,
  executePersistenceCodecProcessor,
} from "../../application/persistence/support";
import { createRecoveryHarness } from "../../application/persistence/saga-support";
import { FakeVault } from "./vault-sidecar/support";

const NOTE: NoteIdentityV1 = Object.freeze({
  vaultIdHint: "vault-runtime",
  vaultRelativeMarkdownPath: "Notes/Example.md",
});
const SIDECAR_PATH = "Notes/Example.inkbook.json";
const MARKDOWN_DIGEST = parseSha256Digest("a".repeat(64));
const BASE: SidecarBaseIdentityV1 = Object.freeze({
  markdownPath: NOTE.vaultRelativeMarkdownPath,
  rawTextSha256: parseSha256Digest("b".repeat(64)),
  revision: createSidecarRevision(1),
  vaultRelativePath: SIDECAR_PATH,
});

describe("RuntimeExternalSidecarChangeV1 external writes", () => {
  it("binds only when the owner config supplies an external Vault", () => {
    const harness = runtimeHarness();
    expect(
      bindRuntimeExternalSidecarChangeV1(
        {
          persistenceCodecPort: harness.codec,
          recovery: harness.recovery,
          sourceDigestWorkPort: harness.digest,
        },
        harness.bindingPorts,
      ),
    ).toBeNull();
  });

  it("loads an exact-path modification through bounded workers and resolves reload with recovery CAS", async () => {
    const harness = runtimeHarness();
    const file = addHostFile(harness.vault, SIDECAR_PATH, harness.externalRaw);

    const observed = await harness.runtime.accept({
      kind: "modify",
      target: file,
    });
    expect(observed).toMatchObject({ ok: true, value: { kind: "conflict" } });
    expect(harness.log).toEqual(["conflict"]);
    expect(harness.codec.submissions).toBe(1);
    expect(harness.digest.submissions).toBe(1);
    expect(harness.vault.cachedReadCalls).toBe(1);

    await expect(
      harness.runtime.resolve({
        confirmedDiscardUnsaved: true,
        kind: "reload",
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(harness.log).toEqual(["conflict", "reload:2"]);
    expect(harness.discardCalls).toBe(1);
    expect(harness.codec.submissions).toBe(2);
    expect(harness.digest.submissions).toBe(2);
    expect(harness.runtime.pendingConflict).toBeNull();
  });

  it("rejects an over-limit stat before Vault read or worker admission", async () => {
    const harness = runtimeHarness();
    const file = addHostFile(
      harness.vault,
      SIDECAR_PATH,
      harness.externalRaw,
      SIDECAR_RESOURCE_LIMITS_V1.maxUtf8Bytes + 1,
    );

    await expect(
      harness.runtime.accept({ kind: "create", target: file }),
    ).resolves.toEqual({ ok: false, code: "resource-limit" });
    expect(harness.log).toEqual(["unreadable"]);
    expect(harness.vault.cachedReadCalls).toBe(0);
    expect(harness.codec.submissions).toBe(0);
    expect(harness.digest.submissions).toBe(0);
  });
});

describe("RuntimeExternalSidecarChangeV1 conflict choices", () => {
  it("does not publish reload when the recovery snapshot changes after observation", async () => {
    const harness = runtimeHarness();
    const file = addHostFile(harness.vault, SIDECAR_PATH, harness.externalRaw);
    await harness.runtime.accept({ kind: "modify", target: file });
    const relocation = relocationRecord();
    await harness.recovery.beginRelocation(relocation);

    await expect(
      harness.runtime.resolve({
        confirmedDiscardUnsaved: true,
        kind: "reload",
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    expect(harness.discardCalls).toBe(1);
    expect(harness.log).toEqual(["conflict"]);
    expect(harness.relocationRecords.get(relocation.relocationId)).toEqual(
      relocation,
    );
  });

  it("keeps cancel read-only and creates one local copy before reload", async () => {
    const harness = runtimeHarness();
    const file = addHostFile(harness.vault, SIDECAR_PATH, harness.externalRaw);
    await harness.runtime.accept({ kind: "modify", target: file });

    await expect(
      harness.runtime.resolve({ kind: "cancel-read-only" }),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(harness.runtime.pendingConflict).not.toBeNull();

    await expect(
      harness.runtime.resolve({
        kind: "conflict-copy",
        suffix: "0123ABCD",
        utcBasicTimestamp: "20260820T170000Z",
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    const copyPath =
      "Notes/Example.inkbook.conflict-20260820T170000Z-0123ABCD.json";
    expect(harness.vault.texts.get(copyPath)).toBe(harness.localRaw);
    expect(harness.log).toEqual([
      "conflict",
      "read-only",
      "prepare-copy",
      "reload:2",
    ]);
  });

  it("enforces the exact three-copy cap before preparing another payload", async () => {
    const harness = runtimeHarness();
    const file = addHostFile(harness.vault, SIDECAR_PATH, harness.externalRaw);
    await harness.runtime.accept({ kind: "modify", target: file });
    for (const suffix of ["11111111", "22222222", "33333333"]) {
      harness.vault.addFile(
        `Notes/Example.inkbook.conflict-20260820T160000Z-${suffix}.json`,
        suffix,
      );
    }

    await expect(
      harness.runtime.resolve({
        kind: "conflict-copy",
        suffix: "44444444",
        utcBasicTimestamp: "20260820T170000Z",
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    expect(harness.log).toEqual(["conflict"]);
    expect(harness.vault.createCalls).toBe(0);
  });
});

describe("RuntimeExternalSidecarChangeV1 rename and delete", () => {
  it("publishes drift for external loss while retaining recovery records", async () => {
    const harness = runtimeHarness();
    const relocation = relocationRecord();
    await harness.recovery.beginRelocation(relocation);

    await expect(
      harness.runtime.accept({
        kind: "delete",
        target: hostFile(SIDECAR_PATH),
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: "missing-drift" },
    });
    expect(harness.log).toEqual(["drift:none"]);
    expect(harness.relocationRecords.get(relocation.relocationId)).toEqual(
      relocation,
    );
  });

  it("routes a deleted containing folder to sidecar drift", async () => {
    const harness = runtimeHarness();

    await expect(
      harness.runtime.accept({ kind: "delete", target: hostFolder("Notes") }),
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: "missing-drift" },
    });
    expect(harness.log).toEqual(["drift:none"]);
  });

  it("leaves a deleted Markdown source as an orphan review candidate", async () => {
    const harness = runtimeHarness();

    await expect(
      harness.runtime.accept({
        kind: "delete",
        target: hostFile(NOTE.vaultRelativeMarkdownPath),
      }),
    ).resolves.toEqual({ ok: true, value: { kind: "unrelated" } });
    expect(harness.log).toEqual([]);
  });

  it("consumes an exact owned relocation ID once and routes its replay to drift", async () => {
    const relocation = relocationRecord();
    const harness = runtimeHarness(relocation);
    const event = {
      kind: "rename" as const,
      oldPath: relocation.sourceSidecarPath,
      target: hostFile(relocation.destinationSidecarPath),
    };

    await expect(
      harness.runtime.accept(event, relocation.relocationId),
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: "owned-relocation" },
    });
    await expect(
      harness.runtime.accept(event, relocation.relocationId),
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: "missing-drift" },
    });
    expect(harness.log).toEqual([`drift:${relocation.destinationSidecarPath}`]);
  });
});

interface RuntimeHarnessV1 {
  readonly bindingPorts: RuntimeExternalChangeBindingPortsV1;
  readonly codec: ImmediateCodecPort;
  readonly digest: ImmediateDigestPort;
  readonly discardCalls: number;
  readonly externalRaw: string;
  readonly localRaw: string;
  readonly log: string[];
  readonly recovery: RecoveryStore;
  readonly relocationRecords: Map<string, FileRelocationRecordV1>;
  readonly runtime: RuntimeExternalSidecarChangeV1;
  readonly vault: FakeVault;
}

function runtimeHarness(
  activeRelocation: FileRelocationRecordV1 | null = null,
): RuntimeHarnessV1 {
  const recoveryHarness = createRecoveryHarness();
  let discardCalls = 0;
  const recovery: RecoveryStore = {
    ...recoveryHarness.store,
    discardConfirmedNoteRecovery: async (request) => {
      discardCalls += 1;
      return recoveryHarness.store.discardConfirmedNoteRecovery(request);
    },
  };
  const vault = new FakeVault();
  const codec = new ImmediateCodecPort();
  const digest = new ImmediateDigestPort();
  const log: string[] = [];
  const externalRaw = encodedRawText(externalSidecar());
  const localRaw = encodedRawText(completeSidecar());
  const context = runtimeContext(activeRelocation);
  const ports: RuntimeExternalChangeBindingPortsV1 = {
    consumeOwnedWrite: () => false,
    decodedBytes: new PersistenceDecodedBytePoolV1(),
    prepareLocalConflictCopy: async () => {
      log.push("prepare-copy");
      return commandSuccess({
        rawText: localRaw,
        utf8Bytes: new TextEncoder().encode(localRaw).byteLength,
      });
    },
    publishConflict: async () => logSuccess(log, "conflict"),
    publishMissingDrift: async (drift) =>
      logSuccess(log, `drift:${drift.movedPath ?? "none"}`),
    publishReload: async (reload) =>
      logSuccess(log, `reload:${String(reload.base.revision)}`),
    publishUnreadableConflict: async () => logSuccess(log, "unreadable"),
    readContext: () => context,
    remainReadOnly: async () => logSuccess(log, "read-only"),
  };
  const runtime = bindRuntimeExternalSidecarChangeV1(
    {
      externalVault: vault,
      persistenceCodecPort: codec,
      recovery,
      sourceDigestWorkPort: digest,
    },
    ports,
  );
  if (runtime === null) throw new Error("Expected external-change binding.");
  return {
    bindingPorts: ports,
    codec,
    digest,
    get discardCalls(): number {
      return discardCalls;
    },
    externalRaw,
    localRaw,
    log,
    recovery,
    relocationRecords: recoveryHarness.relocations as Map<
      string,
      FileRelocationRecordV1
    >,
    runtime,
    vault,
  };
}

function runtimeContext(
  activeRelocation: FileRelocationRecordV1 | null,
): RuntimeExternalChangeContextV1 {
  return {
    activeRelocation,
    expectedBase: BASE,
    noteIdentity: NOTE,
    recoveryLoadRequest: {
      base: BASE,
      currentMarkdownDigest: MARKDOWN_DIGEST,
      currentMarkdownUtf16Length: 1,
      kind: "existing-sidecar",
      noteIdentity: NOTE,
      validatedSidecarSourceDigest: MARKDOWN_DIGEST,
      validatedSidecarSourceGeneration: createSourceGeneration(1),
    },
  };
}

function externalSidecar(): InkbookSidecarV1 {
  return {
    ...completeSidecar(),
    baseRevision: 1,
    revision: 2,
  };
}

function relocationRecord(): FileRelocationRecordV1 {
  return {
    destinationMarkdownPath: "Archive/Example.md",
    destinationSidecarPath: "Archive/Example.inkbook.json",
    expectedSceneRevision: createSceneRevision(1),
    expectedSettingsRevision: createSettingsRevision(1),
    kind: "markdown-file",
    noteIdentity: NOTE,
    relocationId: parseRelocationId("rel_00000000000000000000000000"),
    sidecarBase: BASE,
    sourceMarkdownPath: NOTE.vaultRelativeMarkdownPath,
    sourceSidecarPath: SIDECAR_PATH,
    step: "prepared",
  };
}

function logSuccess(log: string[], message: string): CommandResultV1<void> {
  log.push(message);
  return commandSuccess(undefined);
}

function hostFile(path: string, size = 0): TFile {
  const file = new TFile();
  file.path = path;
  file.stat.size = size;
  return file;
}

function hostFolder(path: string): TFolder {
  const folder = new TFolder();
  folder.path = path;
  return folder;
}

function addHostFile(
  vault: FakeVault,
  path: string,
  text: string,
  reportedSize = new TextEncoder().encode(text).byteLength,
): TFile {
  const file = hostFile(path, reportedSize);
  vault.entries.set(path, file);
  vault.texts.set(path, text);
  return file;
}

class ImmediateCodecPort implements PersistenceCodecPortV1 {
  public submissions = 0;

  public submit(work: PersistenceCodecWorkV1): PersistenceCodecSubmissionV1 {
    this.submissions += 1;
    let cancelled = false;
    return {
      cancel: (): void => {
        cancelled = true;
      },
      result: Promise.resolve().then(() => {
        if (cancelled) throw new Error("cancelled");
        return executePersistenceCodecProcessor(work);
      }),
    };
  }
}

function encodedRawText(sidecar: InkbookSidecarV1): string {
  const result = executePersistenceCodecProcessor(
    createPersistenceEncodeWorkV1(sidecar, "desktop-tablet", 1, 1),
  );
  if (result.kind !== "encoded-sidecar") {
    throw new Error("Expected encoded sidecar fixture.");
  }
  return new TextDecoder().decode(result.bytes);
}

class ImmediateDigestPort implements SourceDigestWorkPortV1 {
  public submissions = 0;

  public submit(): SourceDigestWorkSubmissionV1 {
    this.submissions += 1;
    const sink = createStreamingSha256PortV1().create();
    let settled = false;
    let resolve!: (
      value: Awaited<SourceDigestWorkSubmissionV1["completion"]>,
    ) => void;
    const completion = new Promise<
      Awaited<SourceDigestWorkSubmissionV1["completion"]>
    >((complete) => {
      resolve = complete;
    });
    return {
      cancel: (): void => {
        if (settled) return;
        settled = true;
        sink.dispose?.();
        resolve(commandFailure("disposed"));
      },
      closeInput: (): void => {
        if (settled) return;
        settled = true;
        void sink.finish().then((digest) => resolve(commandSuccess(digest)));
      },
      completion,
      update: (chunk): void | Promise<void> => sink.update(chunk),
    };
  }
}
