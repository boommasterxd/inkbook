import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";

import { serializeRuntimeSceneStateV1 } from "../../../src/domain/codecs";
import { createSceneRevision } from "../../../src/domain/model";
import { createRuntimeSceneStateV1 } from "../../../src/domain/scene";
import {
  createHostTransactionSequence,
  createSidecarRevision,
  createSourceGeneration,
  createSettingsRevision,
  parseRemovalId,
  type CommandResultV1,
  type NoteIdentityV1,
  type Sha256Digest,
  type ViewId,
} from "../../../src/application/note-session";
import type {
  ActiveRemovalRecoveryV1,
  RecoverySnapshotV1,
  RecoveryStore,
  RemovalRecordV1,
} from "../../../src/application/recovery";
import {
  PersistencePermitPool,
  type InkbookSidecarV1,
} from "../../../src/application/persistence";
import { createRuntimeSessionV1 } from "../../../src/adapters/obsidian/runtime-session";
import type { RuntimeSceneStateV1 } from "../../../src/domain/scene";
import {
  digestRuntimeTextV1,
  type RuntimeSidecarResolutionV1,
} from "../../../src/adapters/obsidian/runtime-persistence-open";
import type { SidecarVaultCapability } from "../../../src/adapters/obsidian/vault-sidecar/repository";
import { decodeInkbookSidecarV1 } from "../../../src/application/persistence";
import { preparedSidecarWrite } from "./vault-sidecar/support";
import {
  createSharedWorkerPortsV1,
  type SharedWorkerPortsV1,
} from "../../../src/workers/shared-worker-ports";
import { createDeferred } from "../../application/persistence/first-sidecar-support";

const IDENTITY: NoteIdentityV1 = Object.freeze({
  vaultIdHint: "vault-runtime",
  vaultRelativeMarkdownPath: "Notes/shared.md",
});
const SIDECAR_PATH = "Notes/shared.inkbook.json";
const FIRST_VIEW = "runtime-view-1" as ViewId;
const SECOND_VIEW = "runtime-view-2" as ViewId;

describe("RuntimePersistenceV1", () => {
  it("collapses a two-pane source transition into one checkpoint and save, then reopens", async () => {
    const priorMarkdown = "Native Markdown";
    const replacementMarkdown = `${priorMarkdown}!`;
    const priorDigest = await requiredDigest(priorMarkdown);
    const vault = new MemorySidecarVault(
      SIDECAR_PATH,
      preparedSidecarWrite(
        sidecar(priorDigest, createSourceGeneration(1)),
        "desktop-tablet",
      ).rawText,
    );
    const openGate = createDeferred<true>();
    const recovery = new RuntimeRecoveryFake(openGate.promise);
    const workers = runtimeWorkers();
    const first = composition(vault, recovery, priorMarkdown, workers);
    first.persistence?.attachView(FIRST_VIEW);
    first.persistence?.attachView(SECOND_VIEW);
    await recovery.loadStarted.promise;
    openGate.resolve(true);
    await enqueueBarrier(first.session);
    expect(vault.processCount).toBe(0);
    const transition = Object.freeze({
      hostTransactionSequence: createHostTransactionSequence(1),
      offsetMap: Object.freeze({
        spans: Object.freeze([
          Object.freeze({
            newFromUtf16: priorMarkdown.length,
            newToUtf16: replacementMarkdown.length,
            oldFromUtf16: priorMarkdown.length,
            oldToUtf16: priorMarkdown.length,
          }),
        ]),
      }),
      priorDocument: sourceDocument(priorMarkdown),
      replacementDocument: sourceDocument(replacementMarkdown),
    });

    first.persistence?.acceptSourceTransition(FIRST_VIEW, transition);
    first.persistence?.acceptSourceTransition(SECOND_VIEW, transition);
    await enqueueBarrier(first.session);
    await expect(first.persistence?.flush()).resolves.toBe("flushed");

    expect(recovery.checkpointCount).toBe(1);
    expect(recovery.acknowledgementCount).toBe(1);
    expect(vault.processCount).toBe(1);
    expect(first.session.snapshot.source).toMatchObject({
      generation: Number("2"),
    });
    await first.persistence?.acceptVaultChange({
      kind: "modify",
      target: vault.file,
    });
    expect(first.session.snapshot.persistence.kind).toBe("clean");
    const saved = decodeInkbookSidecarV1(vault.rawText);
    expect(saved.kind).toBe("current");
    if (saved.kind !== "current") throw new Error("Expected current sidecar.");
    expect(saved.sidecar.noteIdentity.sourceGeneration).toBe(Number("2"));
    expect(saved.sidecar.noteIdentity.markdownContentDigest).toBe(
      await requiredDigest(replacementMarkdown),
    );
    await first.session.dispose(false);

    const reopened = composition(vault, recovery, replacementMarkdown, workers);
    await enqueueBarrier(reopened.session);
    expect(reopened.session.snapshot.persistence.kind).toBe("clean");
    expect(reopened.session.snapshot.source).toMatchObject({
      generation: Number("2"),
      kind: "durable",
    });
    expect(reopened.session.snapshot.scene).toEqual(
      first.session.snapshot.scene,
    );
    await reopened.session.dispose(false);
    workers.dispose();
  });
});

function sourceDocument(markdown: string): {
  readonly utf16Length: number;
  sliceString(fromUtf16: number, toUtf16: number): string;
} {
  return Object.freeze({
    sliceString: (fromUtf16: number, toUtf16: number): string =>
      markdown.slice(fromUtf16, toUtf16),
    utf16Length: markdown.length,
  });
}

describe("RuntimePersistenceV1 external changes", () => {
  it("routes an external sidecar overwrite through reload and history replacement", async () => {
    const markdown = "Native Markdown";
    const digest = await requiredDigest(markdown);
    const vault = new MemorySidecarVault(
      SIDECAR_PATH,
      preparedSidecarWrite(
        sidecar(digest, createSourceGeneration(1)),
        "desktop-tablet",
      ).rawText,
    );
    const recovery = new RuntimeRecoveryFake();
    const workers = runtimeWorkers();
    const runtime = composition(vault, recovery, markdown, workers);
    await enqueueBarrier(runtime.session);
    vault.replace(
      preparedSidecarWrite(
        {
          ...sidecar(digest, createSourceGeneration(1)),
          baseRevision: 1,
          revision: 2,
        },
        "desktop-tablet",
      ).rawText,
    );

    await runtime.persistence?.acceptVaultChange({
      kind: "modify",
      target: vault.file,
    });
    expect(runtime.session.snapshot.persistence.kind).toBe("conflict");
    expect(runtime.persistence?.issueStatus).toEqual({
      conflict: { kind: "sidecar-changed" },
      drift: { kind: "none" },
      retry: { kind: "not-required" },
    });
    await expect(
      runtime.persistence?.resolveExternalChange({
        confirmedDiscardUnsaved: true,
        kind: "reload",
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(runtime.session.snapshot.persistence).toMatchObject({
      kind: "clean",
      sidecarRevision: 2,
    });
    expect(runtime.persistence?.issueStatus).toEqual({
      conflict: { kind: "none" },
      drift: { kind: "none" },
      retry: { kind: "not-required" },
    });
    expect(recovery.discardCount).toBe(1);
    await runtime.session.dispose(false);
    workers.dispose();
  });
});

describe("RuntimePersistenceV1 removal", () => {
  it.each([
    ["trash-only", true, false, 0],
    ["delete-only", false, true, 1],
    ["both signals", true, true, 0],
  ] as const)(
    "resumes %s recovery through the production owner",
    async (
      _case,
      trashAcknowledged,
      deleteEventAcknowledged,
      expectedTrashCount,
    ) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(Number("20000"));
      const markdown = "Native Markdown";
      const digest = await requiredDigest(markdown);
      const vault = new MemorySidecarVault(
        SIDECAR_PATH,
        preparedSidecarWrite(
          sidecar(digest, createSourceGeneration(1)),
          "desktop-tablet",
        ).rawText,
      );
      const recovery = new RuntimeRecoveryFake();
      recovery.activeRemoval = {
        attempts: [],
        checkpoints: [],
        removal: {
          ...removalRecord(await requiredDigest(vault.rawText)),
          deleteEventAcknowledged,
          trashAcknowledged,
        },
      };
      vault.present = false;
      let trashCount = 0;
      const workers = runtimeWorkers();
      const runtime = composition(vault, recovery, markdown, workers, {
        trashSidecar: async () => {
          trashCount += 1;
        },
      });
      await enqueueBarrier(runtime.session);
      if (!deleteEventAcknowledged)
        await runtime.persistence?.acceptVaultChange({
          kind: "delete",
          target: vault.file,
        });
      await recovery.finalized.promise;

      expect(runtime.session.snapshot.persistence.kind).toBe("unannotated");
      expect(recovery.activeRemoval).toBeNull();
      expect(recovery.finalizeCount).toBe(1);
      expect(trashCount).toBe(expectedTrashCount);
      expect(vault.frontmatter).toEqual({});
      await runtime.session.dispose(false);
      workers.dispose();
      now.mockRestore();
    },
  );
});

function composition(
  vault: MemorySidecarVault,
  recovery: RuntimeRecoveryFake,
  initialMarkdown: string,
  workers: SharedWorkerPortsV1,
  removalTrash?: {
    readonly trashSidecar: (record: RemovalRecordV1) => Promise<void>;
  },
): ReturnType<typeof createRuntimeSessionV1> {
  const resolution: RuntimeSidecarResolutionV1 = {
    kind: "existing",
    sidecarPath: SIDECAR_PATH,
  };
  const recoveryStore = recovery as unknown as RecoveryStore;
  const noteFile = Object.assign(Object.create(TFile.prototype) as TFile, {
    path: IDENTITY.vaultRelativeMarkdownPath,
    stat: { size: 0 },
  });
  return createRuntimeSessionV1(
    IDENTITY,
    { release: (): void => undefined, tryReserve: (): boolean => true },
    recoveryStore,
    { mode: "adjacent", version: 1 },
    {
      externalVault: vault,
      initialMarkdown,
      markerHost: {
        normalizePath: (path): string => path,
        processFrontMatter: async (_file, callback): Promise<void> => {
          callback(vault.frontmatter);
        },
      },
      persistenceCodecPort: workers.persistenceCodec,
      permits: new PersistencePermitPool("desktop-tablet"),
      readActiveStorageRootRelocation: () => null,
      readPolicyCreationBlocked: () => false,
      recovery: recoveryStore,
      ...(removalTrash === undefined ? {} : { removalTrash }),
      resolution,
      resolveMarkdownFile: (): TFile => noteFile,
      settingsRevision: createSettingsRevision(1),
      sourceDigestWorkPort: workers.sourceDigest,
      sourceMapWorkPort: workers.sourceMapCompaction,
      storagePolicy: { mode: "adjacent", version: 1 },
      vault,
      writableTier: "desktop-tablet",
    },
  );
}

function runtimeWorkers(): SharedWorkerPortsV1 {
  const revision = Object.freeze({ layout: 0, scene: 0 });
  return createSharedWorkerPortsV1({
    clock: { now: (): number => performance.now() },
    environment: null,
    isCurrent: (candidate): boolean =>
      candidate.layout === revision.layout &&
      candidate.scene === revision.scene,
    readRevision: () => revision,
    slices: {
      schedule: (_mode, callback): (() => void) => {
        const handle = setTimeout(callback, 0);
        return (): void => clearTimeout(handle);
      },
    },
  });
}

async function enqueueBarrier(
  session: ReturnType<typeof composition>["session"],
): Promise<void> {
  const result = await session.enqueue({
    kind: "lifecycle",
    retainedBytes: 0,
    run: (): void => undefined,
  });
  expect(result.kind).toBe("completed");
}

async function requiredDigest(value: string): Promise<Sha256Digest> {
  const digest = await digestRuntimeTextV1(value);
  if (digest === null) throw new Error("Expected a bounded digest.");
  return digest;
}

function sidecar(
  markdownContentDigest: Awaited<ReturnType<typeof requiredDigest>>,
  sourceGeneration: ReturnType<typeof createSourceGeneration>,
): InkbookSidecarV1 {
  return {
    baseRevision: null,
    format: "inkbook-obsidian-annotations",
    noteIdentity: {
      markdownContentDigest,
      sourceGeneration,
      vaultRelativeMarkdownPath: IDENTITY.vaultRelativeMarkdownPath,
    },
    revision: 1,
    savedAtEpochMs: 1,
    scene: serializeRuntimeSceneStateV1(emptyScene()),
    schemaVersion: { major: 1, minor: 0 },
    storageLayout: { kind: "adjacent" },
  };
}

function emptyScene(): RuntimeSceneStateV1 {
  return createRuntimeSceneStateV1({
    elements: [],
    groups: [],
    noteAppearance: {
      background: "none",
      contrast: "low",
      horizontalSpacing: "standard",
    },
    objectOrder: [],
    revision: createSceneRevision(0),
  });
}

class RuntimeRecoveryFake {
  acknowledgementCount = 0;
  checkpointCount = 0;
  discardCount = 0;
  readonly loadStarted = createDeferred<true>();
  readonly finalized = createDeferred<true>();
  activeRemoval: ActiveRemovalRecoveryV1 | null = null;
  finalizeCount = 0;

  public constructor(readonly loadGate: Promise<true> | null = null) {}

  async loadNote(): Promise<CommandResultV1<RecoverySnapshotV1>> {
    this.loadStarted.resolve(true);
    if (this.loadGate !== null) await this.loadGate;
    const snapshot: RecoverySnapshotV1 = {
      attempts: [],
      checkpoints: [],
      relocations: [],
      removals: [],
    };
    return { ok: true as const, value: snapshot };
  }

  async appendSourceCheckpoint(): Promise<CommandResultV1<void>> {
    this.checkpointCount += 1;
    return { ok: true as const, value: undefined };
  }

  async acknowledgeSidecar(): Promise<CommandResultV1<void>> {
    this.acknowledgementCount += 1;
    return { ok: true as const, value: undefined };
  }

  async discardConfirmedNoteRecovery(): Promise<CommandResultV1<void>> {
    this.discardCount += 1;
    return { ok: true as const, value: undefined };
  }

  async loadActiveRemoval(): Promise<
    CommandResultV1<ActiveRemovalRecoveryV1 | null>
  > {
    return { ok: true, value: this.activeRemoval };
  }

  async beginRemoval(record: RemovalRecordV1): Promise<CommandResultV1<void>> {
    this.activeRemoval = { attempts: [], checkpoints: [], removal: record };
    return { ok: true, value: undefined };
  }

  async advanceRemoval(request: {
    readonly replacement: RemovalRecordV1;
  }): Promise<CommandResultV1<void>> {
    if (this.activeRemoval === null)
      return { ok: false, code: "sidecar-drift" };
    this.activeRemoval = {
      ...this.activeRemoval,
      removal: request.replacement,
    };
    return { ok: true, value: undefined };
  }

  async finalizeRemovalRecovery(): Promise<CommandResultV1<void>> {
    this.finalizeCount += 1;
    this.activeRemoval = null;
    this.finalized.resolve(true);
    return { ok: true, value: undefined };
  }

  dispose = (): Promise<void> => Promise.resolve();
}

function removalRecord(rawTextSha256: Sha256Digest): RemovalRecordV1 {
  return {
    deadlineEpochMs: Number("22000"),
    deleteEventAcknowledged: false,
    expectedSceneRevision: createSceneRevision(0),
    kind: "annotation-removal",
    markerState: "present",
    noteIdentity: IDENTITY,
    removalId: parseRemovalId("rm_00000000000000000000000000"),
    sidecarBase: {
      markdownPath: IDENTITY.vaultRelativeMarkdownPath,
      rawTextSha256,
      revision: createSidecarRevision(1),
      vaultRelativePath: SIDECAR_PATH,
    },
    trashAcknowledged: false,
  };
}

class MemorySidecarVault implements SidecarVaultCapability {
  readonly file = Object.assign(Object.create(TFile.prototype) as TFile, {
    path: SIDECAR_PATH,
    stat: { size: 0 },
  });
  processCount = 0;
  readonly frontmatter: Record<string, unknown> = {
    "inkbook-annotations": true,
    "inkbook-sidecar": SIDECAR_PATH,
  };
  present = true;

  public constructor(
    readonly path: string,
    public rawText: string,
  ) {
    this.file.stat.size = new TextEncoder().encode(rawText).byteLength;
  }

  readonly normalizePath = (path: string): string => path;
  getFileByPath(path: string): typeof this.file | null {
    return this.present && path === this.path ? this.file : null;
  }
  getFolderByPath(): null {
    return null;
  }
  getFiles(): readonly (typeof this.file)[] {
    return [this.file];
  }
  async cachedRead(): Promise<string> {
    return this.rawText;
  }
  async create(): Promise<never> {
    throw new Error("Unexpected create.");
  }
  async createFolder(): Promise<void> {
    throw new Error("Unexpected folder create.");
  }
  async process(
    _file: typeof this.file,
    callback: (currentText: string) => string,
  ): Promise<string> {
    this.processCount += 1;
    this.rawText = callback(this.rawText);
    this.file.stat.size = new TextEncoder().encode(this.rawText).byteLength;
    return this.rawText;
  }

  replace(rawText: string): void {
    this.rawText = rawText;
    this.file.stat.size = new TextEncoder().encode(rawText).byteLength;
  }
}
