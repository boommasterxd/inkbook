import { parseInkbookDocumentForTest } from "../../../../fixtures/persistence/parse-document";
import type { TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { CANONICAL_THEME_STYLESHEET } from "../../../../../src/persistence/documents/svg-theme";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/public";
import type { DocumentRuntimePort } from "../../../../../src/persistence/worker/runtime/public";
import { legacyImageDocument } from "../../../../fixtures/persistence/legacy-image-svg";

import {
  createVaultSessionFactory,
  emptySnapshot,
  operation,
  rectangle,
  TestTFile,
  versionZeroDocumentFromSnapshot,
} from "./vault-session-fixtures";

function migrationHarness(options: {
  readonly createRuntime?: (sessionId: string, workerEpoch: number) => Promise<DocumentRuntimePort>;
  readonly failBackup?: boolean;
  readonly legacyTheme?: boolean;
  readonly legacyImageVersion?: 3 | 4;
}) {
  const original =
    options.legacyImageVersion !== undefined
      ? legacyImageDocument(options.legacyImageVersion)
      : options.legacyTheme
        ? legacyThemeDocument()
        : versionZeroDocumentFromSnapshot();
  let content = original.svg;
  const file = new TestTFile("drawings/ink.svg", original.bytes.byteLength);
  const copies = new Map<string, { file: TFile; text: string }>();
  const process = vi.fn(async (_file: TFile, update: (current: string) => string) => {
    content = update(content);
    file.stat.size = new TextEncoder().encode(content).byteLength;
    return content;
  });
  const create = vi.fn(async (path: string, text: string) => {
    if (options.failBackup && path.startsWith("drawings/ink.backup-v")) {
      throw new Error("backup creation failed");
    }
    const created = new TestTFile(path, new TextEncoder().encode(text).byteLength);
    copies.set(path, { file: created, text });
    return created;
  });
  const getFileByPath = vi.fn((path: string) =>
    path === file.path ? file : (copies.get(path)?.file ?? null),
  );
  const vault = {
    create,
    getFileByPath,
    getFolderByPath: () => null,
    process,
    read: async (target: TFile) => copies.get(target.path)?.text ?? content,
    readBinary: async () => new TextEncoder().encode(content).buffer,
  };
  const factory = createVaultSessionFactory(vault, options.createRuntime);
  return {
    content: () => content,
    copies,
    create,
    factory,
    getFileByPath,
    original,
    process,
    session: factory.create({ documentId: file.path, sessionId: "session-1" }),
  };
}

async function commitAndLock(harness: ReturnType<typeof migrationHarness>, operationId: number) {
  const model = harness.factory.getDocumentModel("session-1");
  if (model === undefined) throw new Error("Expected an editable migrated model.");
  if (operationId === 2) model.commitElement(rectangle());
  else model.commitPage({ ...model.page, activeBufferLines: 4 });
  return harness.session.lockLatest({ ...operation(), operationId, workspaceToken: operationId });
}

describe("vault document migration persistence", () => {
  it("backs up the exact source once before the first version one replacement", async () => {
    const harness = migrationHarness({});
    await expect(harness.session.unlock(operation())).resolves.toMatchObject({ status: "active" });

    await expect(commitAndLock(harness, 2)).resolves.toMatchObject({
      revision: 8,
      status: "confirmed",
    });
    expect(harness.copies.get("drawings/ink.backup-v0.svg")?.text).toBe(harness.original.svg);
    expect(harness.process).toHaveBeenCalledOnce();
    expect(await parseInkbookDocumentForTest(harness.content())).toMatchObject({
      ok: true,
      value: { snapshot: { version: 1 }, sourceVersion: 1 },
    });

    await expect(commitAndLock(harness, 3)).resolves.toMatchObject({
      revision: 9,
      status: "confirmed",
    });
    expect(harness.copies.size).toBe(1);
    expect(harness.copies.get("drawings/ink.backup-v0.svg")?.text).toBe(harness.original.svg);
  });

  it("does not overwrite the source when backup creation fails", async () => {
    const harness = migrationHarness({ failBackup: true });
    await expect(harness.session.unlock(operation())).resolves.toMatchObject({ status: "active" });

    await expect(commitAndLock(harness, 2)).resolves.toMatchObject({ status: "failed" });

    expect(harness.process).not.toHaveBeenCalled();
    expect(harness.content()).toBe(harness.original.svg);
  });
});

it("preserves the exact image source when its first edited-save backup fails", async () => {
  const harness = migrationHarness({ legacyImageVersion: 3, failBackup: true });
  try {
    await expect(harness.session.unlock(operation())).resolves.toMatchObject({ status: "active" });
    await expect(commitAndLock(harness, 3)).resolves.toMatchObject({
      status: "failed",
    });
    expect(harness.process).not.toHaveBeenCalled();
    expect(harness.copies.size).toBe(0);
    expect(harness.create).toHaveBeenCalledWith("drawings/ink.backup-v3.svg", harness.original.svg);
    expect(harness.content()).toBe(harness.original.svg);
  } finally {
    harness.session.dispose();
  }
});

function documentBytes(svg: string): { readonly bytes: Uint8Array; readonly svg: string } {
  return { bytes: new TextEncoder().encode(svg), svg };
}

function legacyThemeDocument(): { readonly bytes: Uint8Array; readonly svg: string } {
  const serialized = serializeInkbookDocument(emptySnapshot());
  if (!serialized.ok) throw new Error(serialized.error.code);
  const oldTheme = CANONICAL_THEME_STYLESHEET.replaceAll("#ABABAB40", "#DCDCDCFF")
    .replace("#66666640", "#383838FF")
    .replace(
      ".inkbook-theme-guide{stroke:var(--inkbook-guide);vector-effect:non-scaling-stroke}",
      ".inkbook-theme-guide{stroke:var(--inkbook-guide);shape-rendering:crispEdges;vector-effect:non-scaling-stroke}",
    );
  return documentBytes(serialized.value.svg.replace(CANONICAL_THEME_STYLESHEET, oldTheme));
}
