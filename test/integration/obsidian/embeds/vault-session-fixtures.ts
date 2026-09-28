import { TFile } from "obsidian";
import { vi } from "vitest";

import type { BoxShapeElementV1, InkSnapshotV1 } from "../../../../src/domain/schema/public";
import { SharedFrameScheduler } from "../../../../src/domain/scheduling/shared-frame-scheduler";
import type { StoreSliceScheduler } from "../../../../src/domain/store/public";
import type { DocumentRuntimeFactories } from "../../../../src/obsidian/embeds/document-model-port";
import type { VaultDocumentSessionHooks } from "../../../../src/obsidian/embeds/vault-document-recovery";
import { VaultDocumentSessionFactory } from "../../../../src/obsidian/embeds/vault-document-session-factory";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import {
  DocumentWorkerRuntime,
  type DocumentRuntimePort,
} from "../../../../src/persistence/worker/runtime/public";
import { ManualHost } from "../../../fixtures/scheduling/manual-frame-host";

export const TestTFile = TFile as unknown as new (path: string, size: number) => TFile;

export function createTestDocumentRuntimes(
  executors: Pick<DocumentRuntimeFactories, "create" | "createFallback" | "createStoreScheduler">,
): DocumentRuntimeFactories {
  return {
    workScheduler: () => new SharedFrameScheduler(new ManualHost()),
    clock: () => ({ clearTimeout: vi.fn(), setTimeout: vi.fn() }),
    ...executors,
    now: () => 1,
  };
}

export function emptySnapshot(): InkSnapshotV1 {
  return {
    elements: [],
    format: "inkbook",
    page: {
      activeBufferLines: 3,
      background: { spacing: 50, type: "lines" },
      innerWidth: 2000,
      lockedBufferLines: 1,
      margin: 24.3,
    },
    revision: 7,
    version: 1,
  };
}

export function rectangle(): BoxShapeElementV1 {
  return {
    createdAt: 1,
    height: 80,
    id: "00000000-0000-4000-8000-000000000001",
    kind: "rectangle",
    pivot: { x: 140, y: 140 },
    rotation: 0,
    style: {
      fillColor: null,
      fillOpacity: 0,
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 4,
    },
    width: 80,
    x: 100,
    y: 100,
  };
}

export function documentFromSnapshot(snapshot: InkSnapshotV1 = emptySnapshot()): {
  readonly bytes: Uint8Array;
  readonly svg: string;
} {
  const serialized = serializeInkbookDocument(snapshot);
  if (!serialized.ok) throw new Error(serialized.error.message);
  return { bytes: new TextEncoder().encode(serialized.value.svg), svg: serialized.value.svg };
}

export function readOnlyDocumentVault(document: ReturnType<typeof documentFromSnapshot>) {
  const file = new TestTFile("drawings/ink.svg", document.bytes.byteLength);
  return {
    file,
    vault: {
      getFileByPath: () => file,
      readBinary: async () => document.bytes.buffer.slice(0),
    },
  };
}

export function createReadOnlyVaultSession(
  document: ReturnType<typeof documentFromSnapshot>,
  create?: (sessionId: string, workerEpoch: number) => Promise<DocumentRuntimePort>,
) {
  const { file, vault } = readOnlyDocumentVault(document);
  const factory = createVaultSessionFactory(vault, create);
  return {
    factory,
    file,
    session: factory.create({ documentId: file.path, sessionId: "session-1" }),
  };
}

export function versionZeroDocumentFromSnapshot(snapshot: InkSnapshotV1 = emptySnapshot()): {
  readonly bytes: Uint8Array;
  readonly svg: string;
} {
  const current = documentFromSnapshot(snapshot);
  const svg = current.svg
    .replace('data-inkbook-version="1"', 'data-inkbook-version="0"')
    .replace(/ data-inkbook-snapshot-sha256="[0-9a-f]{64}"/u, "")
    .replace('"version":1', '"version":0');
  return { bytes: new TextEncoder().encode(svg), svg };
}

export function recoveryCopyVaultHarness(options: {
  readonly file: TFile;
  readonly getDocument: () => ReturnType<typeof documentFromSnapshot>;
  readonly getContent?: () => string;
  readonly readCopy?: (copy: { file: TFile; text: string }) => string;
}) {
  const createdCopies = new Map<string, { file: TFile; text: string }>();
  let copyRead = Promise.resolve();
  const vault = {
    create: async (path: string, text: string) => {
      const created = new TestTFile(path, new TextEncoder().encode(text).byteLength);
      createdCopies.set(path, { file: created, text });
      return created;
    },
    getAbstractFileByPath: (path: string) => createdCopies.get(path)?.file ?? null,
    getFileByPath: (path: string) =>
      path === options.file.path ? options.file : (createdCopies.get(path)?.file ?? null),
    getFolderByPath: () => null,
    read: async (target: TFile) => {
      const copy = createdCopies.get(target.path);
      if (copy === undefined) return options.getContent?.() ?? options.getDocument().svg;
      await copyRead;
      return options.readCopy?.(copy) ?? copy.text;
    },
    readBinary: async () => options.getDocument().bytes.buffer.slice(0),
    trash: async (target: TFile) => {
      createdCopies.delete(target.path);
    },
  };
  return {
    createdCopies,
    holdCopyRead: () => {
      let release!: () => void;
      copyRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    vault,
  };
}

export function createVaultSessionFactory(
  vault: object,
  create: (sessionId: string, workerEpoch: number) => Promise<DocumentRuntimePort> = async (
    sessionId,
    workerEpoch,
  ) => new DocumentWorkerRuntime({ sessionId, workerEpoch }),
  createStoreScheduler: (documentId: string, isCancelled: () => boolean) => StoreSliceScheduler = (
    _documentId,
    isCancelled,
  ) => ({
    isCancelled,
    shouldYield: () => false,
    yieldControl: async () => undefined,
  }),
  hooks: VaultDocumentSessionHooks = {},
): VaultDocumentSessionFactory {
  const fileManager = {
    trashFile: async (file: TFile) =>
      (vault as { trash?: (target: TFile, system: boolean) => Promise<void> }).trash?.(file, false),
  };
  return new VaultDocumentSessionFactory(
    vault as never,
    fileManager as never,
    createTestDocumentRuntimes({
      create,
      createFallback: (sessionId, workerEpoch) =>
        new DocumentWorkerRuntime({ sessionId, workerEpoch }),
      createStoreScheduler,
    }),
    hooks,
  );
}

export function persistenceHarness(
  snapshot = emptySnapshot(),
  hooks: VaultDocumentSessionHooks = {},
) {
  let document = documentFromSnapshot(snapshot);
  let content = document.svg;
  let corruptCopyRead = false;
  const file = new TestTFile("drawings/ink.svg", document.bytes.byteLength);
  let processGate = Promise.resolve();
  const process = vi.fn(async (_file: TFile, update: (current: string) => string) => {
    content = update(content);
    file.stat.size = new TextEncoder().encode(content).byteLength;
    await processGate;
    return content;
  });
  const copyHarness = recoveryCopyVaultHarness({
    file,
    getDocument: () => document,
    getContent: () => content,
    readCopy: (copy) => (corruptCopyRead ? "invalid-svg" : copy.text),
  });
  const factory = createVaultSessionFactory(
    { ...copyHarness.vault, process },
    undefined,
    undefined,
    hooks,
  );
  return {
    content: () => content,
    createdCopies: copyHarness.createdCopies,
    factory,
    corruptCopyReads: () => {
      corruptCopyRead = true;
    },
    holdCopyRead: copyHarness.holdCopyRead,
    holdProcess: () => {
      let release!: () => void;
      processGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    process,
    replaceExternal: (next: ReturnType<typeof documentFromSnapshot>) => {
      document = next;
      content = next.svg;
      file.stat.size = next.bytes.byteLength;
    },
    session: factory.create({ documentId: file.path, sessionId: "session-1" }),
  };
}

export function operation() {
  return {
    baseRevision: 7,
    documentId: "drawings/ink.svg",
    operationId: 1,
    sessionId: "session-1",
    workerEpoch: 1,
    workspaceToken: 1,
  } as const;
}
