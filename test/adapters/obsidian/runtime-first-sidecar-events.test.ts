import { TFile, TFolder } from "obsidian";
import { describe, expect, it } from "vitest";

import { createAnnotationOperationV1 } from "../../../src/domain/operations";
import type { PrepareHostEffectRequestV1 } from "../../../src/application/host-history/types";
import {
  createHostTransactionSequence,
  createSessionOrder,
  createSettingsRevision,
  type FirstSidecarPendingV1,
  type SessionOrder,
} from "../../../src/application/note-session";
import {
  PersistencePermitPool,
  type PersistenceCodecPortV1,
  type PersistenceCodecSubmissionV1,
} from "../../../src/application/persistence";
import { executePersistenceCodecProcessor } from "../../application/persistence/support";
import type {
  HostRecordedForwardAttemptV1,
  RecoveryStore,
} from "../../../src/application/recovery";
import { RuntimePersistenceV1 } from "../../../src/adapters/obsidian/runtime-persistence";
import type { RuntimePersistenceHistoryV1 } from "../../../src/adapters/obsidian/runtime-persistence-external";
import type { RuntimeExternalChangeVaultV1 } from "../../../src/adapters/obsidian/runtime-external-change";
import type { FrontMatterHostCapability } from "../../../src/adapters/obsidian/vault-sidecar/marker";
import type { VaultFileCapability } from "../../../src/adapters/obsidian/vault-sidecar/paths";
import {
  ImmediateSourceDigestWorkPort,
  ImmediateSourceMapWorkPort,
  flushSourceUntil,
} from "../../application/source-coordination/support";
import {
  createRecovery,
  type RecoveryFixtureObservations,
  type RecoveryFixtureState,
} from "../../application/host-history/recovery-fixture";
import {
  COMMAND,
  createDeferred,
  createFirstSidecarHarness,
  hostForwardAttempt,
} from "../../application/persistence/first-sidecar-support";

const MARKDOWN = "Native Markdown";
const VIEW_ID = hostForwardAttempt().acknowledgement.editorViewId;

describe("runtime first-sidecar owned create events", () => {
  it("does not claim an unrelated concurrent source transition as the marker checkpoint", async () => {
    const fixture = await createEventFixture();
    fixture.vault.onMarkerWritten = (): void => {
      fixture.persistence.acceptSourceTransition(VIEW_ID, {
        hostTransactionSequence: createHostTransactionSequence(1),
        offsetMap: {
          spans: [
            {
              newFromUtf16: MARKDOWN.length,
              newToUtf16: MARKDOWN.length + 1,
              oldFromUtf16: MARKDOWN.length,
              oldToUtf16: MARKDOWN.length,
            },
          ],
        },
        priorDocument: sourceDocument(MARKDOWN),
        replacementDocument: sourceDocument(`${MARKDOWN}!`),
      });
    };

    await expect(
      fixture.persistence.prepareHostEffect(fixture.request),
    ).resolves.toEqual({ kind: "drift" });
    expect(fixture.harness.session.snapshot.source.kind).toBe(
      "checkpoint-pending",
    );
    await fixture.dispose();
  });

  it("keeps first-sidecar creation usable when a view attaches before async open", async () => {
    const fixture = await createEventFixture({ attachBeforeOpen: true });
    await beginFirstSidecarCreate(fixture);
    await fixture.vault.createStarted;
    fixture.vault.acknowledgeCreate();
    await waitForAdoption(fixture);

    expect(fixture.harness.session.snapshot.persistence).toEqual({
      kind: "clean",
      sidecarRevision: 1,
    });
    await fixture.dispose();
  });

  it("does not publish an external conflict when create arrives before its acknowledgement", async () => {
    const fixture = await createEventFixture();
    const attempt = await beginFirstSidecarCreate(fixture);
    const created = await fixture.vault.createStarted;

    await fixture.persistence.acceptVaultChange({
      kind: "create",
      target: created,
    });
    expect(fixture.harness.session.snapshot.persistence.kind).toBe(
      "first-sidecar-pending",
    );
    fixture.vault.acknowledgeCreate();
    await waitForAdoption(fixture);

    expect(fixture.harness.session.snapshot.persistence).toEqual({
      kind: "clean",
      sidecarRevision: 1,
    });
    expect(attempt.attemptId).toBe(hostForwardAttempt().attemptId);
    await fixture.dispose();
  });

  it("consumes the owned create event after acknowledgement without an external conflict", async () => {
    const fixture = await createEventFixture();
    await beginFirstSidecarCreate(fixture);
    const created = await fixture.vault.createStarted;
    fixture.vault.acknowledgeCreate();
    await waitForAdoption(fixture);

    await fixture.persistence.acceptVaultChange({
      kind: "create",
      target: created,
    });

    expect(fixture.harness.session.snapshot.persistence).toEqual({
      kind: "clean",
      sidecarRevision: 1,
    });
    await expect(
      fixture.persistence.resolveExternalChange({
        kind: "cancel-read-only",
      }),
    ).resolves.toEqual({ code: "invalid-command", ok: false });
    await fixture.dispose();
  });
});

interface EventFixture {
  readonly dispose: () => Promise<void>;
  readonly harness: ReturnType<typeof createFirstSidecarHarness>;
  readonly history: FirstSidecarHistoryFake;
  readonly persistence: RuntimePersistenceV1;
  readonly request: PrepareHostEffectRequestV1;
  readonly vault: ControlledCreateVault;
}

async function createEventFixture(
  options: { readonly attachBeforeOpen?: boolean } = {},
): Promise<EventFixture> {
  const harness = createFirstSidecarHarness();
  const template = hostForwardAttempt();
  const request = requestFromAttempt(template);
  const history = new FirstSidecarHistoryFake(template);
  const vault = new ControlledCreateVault();
  const openGate = options.attachBeforeOpen ? createDeferred<true>() : null;
  const loadStarted = createDeferred<true>();
  const recovery = recoveryStore(openGate?.promise, () => {
    loadStarted.resolve(true);
  });
  const digest = new ImmediateSourceDigestWorkPort();
  const persistence = new RuntimePersistenceV1({
    externalVault: vault,
    history,
    identity: COMMAND.noteIdentity,
    initialMarkdown: MARKDOWN,
    markerHost: vault,
    nextSessionOrder: sequence(),
    permits: new PersistencePermitPool("desktop-tablet"),
    persistenceCodecPort: new ImmediatePersistenceCodec(),
    readActiveStorageRootRelocation: (): null => null,
    readPolicyCreationBlocked: (): boolean => false,
    recovery,
    resolution: {
      kind: "unannotated",
      sidecarPath: COMMAND.expectedVaultRelativePath,
    },
    resolveMarkdownFile: (path): TFile | null =>
      path === COMMAND.noteIdentity.vaultRelativeMarkdownPath
        ? vault.noteFile
        : null,
    settingsRevision: createSettingsRevision(1),
    sourceDigestWorkPort: digest,
    sourceMapWorkPort: new ImmediateSourceMapWorkPort(),
    storagePolicy: { mode: "adjacent", version: 1 },
    vault,
    writableTier: "desktop-tablet",
  });
  vault.onMarkerWritten = (): void => {
    const replacementMarkdown = `---\ninkbook-annotations: true\ninkbook-sidecar: ${COMMAND.expectedVaultRelativePath}\n---\n${MARKDOWN}`;
    const insertedFrontmatterLength =
      replacementMarkdown.length - MARKDOWN.length;
    const transition = {
      hostTransactionSequence: createHostTransactionSequence(1),
      offsetMap: {
        spans: [
          {
            newFromUtf16: 0,
            newToUtf16: insertedFrontmatterLength,
            oldFromUtf16: 0,
            oldToUtf16: 0,
          },
        ],
      },
      priorDocument: sourceDocument(MARKDOWN),
      replacementDocument: sourceDocument(replacementMarkdown),
    };
    persistence.acceptSourceTransition(VIEW_ID, transition);
  };
  persistence.bind(harness.session);
  if (openGate !== null) {
    persistence.attachView(VIEW_ID);
    await loadStarted.promise;
    openGate.resolve(true);
  }
  await enqueueBarrier(harness.session);
  if (openGate === null) persistence.attachView(VIEW_ID);
  return {
    dispose: async (): Promise<void> => {
      await persistence.dispose();
    },
    harness,
    history,
    persistence,
    request,
    vault,
  };
}

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

async function beginFirstSidecarCreate(
  fixture: EventFixture,
): Promise<HostRecordedForwardAttemptV1> {
  const prepared = await fixture.persistence.prepareHostEffect(fixture.request);
  if (prepared.kind !== "prepared") {
    throw new Error("Expected first-sidecar preparation.");
  }
  const persistence = fixture.harness.session.snapshot.persistence;
  if (persistence.kind !== "first-sidecar-pending") {
    throw new Error("Expected a pending first sidecar.");
  }
  const attempt = fixture.history.recordedAttempt(persistence.pending);
  await fixture.harness.publishHostForward();
  fixture.persistence.recordRecoveryAttempt(attempt);
  return attempt;
}

async function waitForAdoption(fixture: EventFixture): Promise<void> {
  await flushSourceUntil(
    () => fixture.harness.session.snapshot.persistence.kind === "clean",
  );
  await flushSourceUntil(() => fixture.vault.cachedReadCalls > 0);
  await Promise.resolve();
  await Promise.resolve();
}

class FirstSidecarHistoryFake implements RuntimePersistenceHistoryV1 {
  readonly #template: HostRecordedForwardAttemptV1;
  public updateCalls = 0;

  public constructor(template: HostRecordedForwardAttemptV1) {
    this.#template = template;
  }

  public initialize(): boolean {
    return true;
  }

  public prepareDispatch(
    request: PrepareHostEffectRequestV1,
  ): ReturnType<RuntimePersistenceHistoryV1["prepareDispatch"]> {
    const operation = createAnnotationOperationV1({
      direction: "forward",
      expectedSceneRevision: 0,
      historyEntryId: request.historyEntry.historyEntryId,
      historyEpoch: request.historyEntry.historyEpoch,
      operationId: request.operationId,
      patch: request.historyEntry.forward,
    });
    if (!operation.ok) return Promise.resolve({ kind: "rejected" });
    return Promise.resolve({
      dispatch: {
        envelope: {
          direction: "forward",
          effectId: request.effectId,
          historyEntryId: request.historyEntry.historyEntryId,
          historyEpoch: request.historyEntry.historyEpoch,
          noteIdentity: COMMAND.noteIdentity,
        },
        intent: operation.value,
        kind: "prepared",
      },
      kind: "prepared",
      recoveryAttemptId: this.#template.attemptId,
    });
  }

  public recordedAttempt(
    pending: FirstSidecarPendingV1,
  ): HostRecordedForwardAttemptV1 {
    return Object.freeze({
      ...this.#template,
      base: Object.freeze({
        markdownPath: COMMAND.noteIdentity.vaultRelativeMarkdownPath,
        rawTextSha256: null,
        revision: null,
        vaultRelativePath: COMMAND.expectedVaultRelativePath,
      }),
      expectedSourceDigest: pending.expectedSourceDigest,
      expectedSourceGeneration: pending.expectedSourceGeneration,
    });
  }

  public replaceAfterExternalReload(): boolean {
    return false;
  }

  public updatePersistenceContext(): void {
    this.updateCalls += 1;
  }
}

class ImmediatePersistenceCodec implements PersistenceCodecPortV1 {
  public submit(
    work: Parameters<PersistenceCodecPortV1["submit"]>[0],
  ): PersistenceCodecSubmissionV1 {
    return {
      cancel: (): void => undefined,
      result: Promise.resolve(executePersistenceCodecProcessor(work)),
    };
  }
}

class ControlledCreateVault
  implements RuntimeExternalChangeVaultV1, FrontMatterHostCapability
{
  readonly #createGate = createDeferred<true>();
  readonly #created = createDeferred<TFile>();
  readonly #entries = new Map<string, TFile | TFolder>();
  readonly #texts = new Map<string, string>();
  readonly frontmatter: Record<string, unknown> = {};
  readonly noteFile = obsidianFile(
    COMMAND.noteIdentity.vaultRelativeMarkdownPath,
  );
  readonly notesFolder = obsidianFolder("Notes");
  cachedReadCalls = 0;
  onMarkerWritten: (() => void) | undefined;

  public constructor() {
    this.#entries.set(this.noteFile.path, this.noteFile);
    this.#entries.set(this.notesFolder.path, this.notesFolder);
  }

  public get createStarted(): Promise<TFile> {
    return this.#created.promise;
  }

  public acknowledgeCreate(): void {
    this.#createGate.resolve(true);
  }

  public readonly normalizePath = (path: string): string => path;

  public getFileByPath(path: string): TFile | TFolder | null {
    return this.#entries.get(path) ?? null;
  }

  public getFolderByPath(path: string): TFile | TFolder | null {
    const value = this.#entries.get(path);
    return value instanceof TFolder ? value : null;
  }

  public getFiles(): readonly TFile[] {
    return [...this.#entries.values()].filter(
      (value): value is TFile => value instanceof TFile,
    );
  }

  public async cachedRead(file: VaultFileCapability): Promise<string> {
    this.cachedReadCalls += 1;
    return this.#texts.get(file.path) ?? "";
  }

  public async create(path: string, contents: string): Promise<TFile> {
    const file = obsidianFile(path, contents);
    this.#entries.set(path, file);
    this.#texts.set(path, contents);
    this.#created.resolve(file);
    await this.#createGate.promise;
    return file;
  }

  public createFolder(): Promise<void> {
    return Promise.resolve();
  }

  public async process(
    file: VaultFileCapability,
    callback: (currentText: string) => string,
  ): Promise<string> {
    const replacement = callback(this.#texts.get(file.path) ?? "");
    this.#texts.set(file.path, replacement);
    return replacement;
  }

  public async processFrontMatter(
    _file: VaultFileCapability,
    callback: (frontmatter: Record<string, unknown>) => void,
  ): Promise<void> {
    callback(this.frontmatter);
    this.onMarkerWritten?.();
  }
}

function requestFromAttempt(
  attempt: HostRecordedForwardAttemptV1,
): PrepareHostEffectRequestV1 {
  return {
    effectId: attempt.acknowledgement.effectId,
    historyEntry: {
      forward: attempt.forward,
      historyEntryId: attempt.historyEntryId,
      historyEpoch: attempt.historyEpoch,
      inverse: attempt.inverse,
    },
    operationId: attempt.operationId,
    viewId: attempt.acknowledgement.editorViewId,
  };
}

function recoveryStore(
  loadGate?: Promise<true>,
  onLoadStarted: () => void = (): void => undefined,
): RecoveryStore {
  const observations: RecoveryFixtureObservations = {
    directionAttempts: [],
    expectedSceneRevisions: [],
    operationIds: [],
    prepareAttempts: [],
    recordedDirections: [],
  };
  const state: RecoveryFixtureState = {
    directionFailures: 0,
    prepareFailures: 0,
    recordFailures: 0,
    recordRelease: Promise.resolve(),
    resolveRecordStarted: (): void => undefined,
  };
  const recovery = createRecovery({}, state, observations);
  return {
    ...recovery,
    loadNote: async (request): ReturnType<RecoveryStore["loadNote"]> => {
      onLoadStarted();
      if (loadGate !== undefined) await loadGate;
      return recovery.loadNote(request);
    },
  };
}

function sequence(): () => SessionOrder {
  let value = 0;
  return () => createSessionOrder(++value);
}

async function enqueueBarrier(
  session: ReturnType<typeof createFirstSidecarHarness>["session"],
): Promise<void> {
  await session.enqueue({
    kind: "lifecycle",
    retainedBytes: 0,
    run: (): void => undefined,
  });
}

function obsidianFile(path: string, contents = ""): TFile {
  return Object.assign(Object.create(TFile.prototype) as TFile, {
    path,
    stat: { size: new TextEncoder().encode(contents).byteLength },
  });
}

function obsidianFolder(path: string): TFolder {
  return Object.assign(Object.create(TFolder.prototype) as TFolder, {
    children: [],
    path,
  });
}
