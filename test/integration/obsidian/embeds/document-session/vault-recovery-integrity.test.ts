import { afterEach, expect, it, vi } from "vitest";

import { DocumentWorkerRuntime } from "../../../../../src/persistence/worker/runtime/public";
import {
  createVaultSessionFactory,
  documentFromSnapshot,
  operation,
  rectangle,
  recoveryCopyVaultHarness,
  TestTFile,
} from "./vault-session-fixtures";

const recoveredPath = "drawings/ink-recovered-1.svg";
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function recoveryHarness() {
  const document = documentFromSnapshot();
  const original = new TestTFile("drawings/ink.svg", document.bytes.byteLength);
  const copies = recoveryCopyVaultHarness({ file: original, getDocument: () => document });
  const create = vi.fn(async (path: string, content: string) => {
    if (copies.createdCopies.has(path)) throw new Error("File already exists");
    return copies.vault.create(path, content);
  });
  const read = vi.fn(copies.vault.read);
  const trash = vi.fn(copies.vault.trash);
  const runtime = new DocumentWorkerRuntime({ sessionId: "session-1", workerEpoch: 1 });
  const terminate = vi.spyOn(runtime, "terminate");
  const factory = createVaultSessionFactory(
    { ...copies.vault, create, read, trash },
    async () => runtime,
  );
  const session = factory.create({ documentId: original.path, sessionId: "session-1" });
  cleanup.push(() => session.dispose());
  await expect(session.unlock(operation())).resolves.toMatchObject({ status: "active" });
  const model = factory.getDocumentModel("session-1")!;
  model.commitElement(rectangle());
  const recoveryOperation = { ...operation(), baseRevision: 8, operationId: 2 };
  return {
    ...copies,
    create,
    read,
    trash,
    runtime,
    terminate,
    model,
    factory,
    session,
    recover: (replaceMarkdownTarget = vi.fn(async () => true)) =>
      session.resolveRecovery("save-local-copy", recoveryOperation, { replaceMarkdownTarget }),
  };
}

function gateRuntime(runtime: DocumentWorkerRuntime, type: "export-full" | "verify-output") {
  const entered = deferred();
  const release = deferred();
  const execute = runtime.execute.bind(runtime);
  vi.spyOn(runtime, "execute").mockImplementation(async (request) => {
    if (request.type === type) {
      entered.resolve();
      await release.promise;
    }
    return execute(request);
  });
  cleanup.push(release.resolve);
  return { entered: entered.promise, release: release.resolve };
}

function expectDirtyOriginal(harness: Awaited<ReturnType<typeof recoveryHarness>>) {
  expect(harness.session.getSnapshot()).toMatchObject({ dirty: true, revision: 8 });
  expect(harness.factory.getDocumentModel("session-1")).toBe(harness.model);
  expect(harness.terminate).not.toHaveBeenCalled();
}

function expectPreservedCopy(
  harness: Awaited<ReturnType<typeof recoveryHarness>>,
  copy: unknown,
  replace: () => Promise<boolean>,
) {
  expect(harness.createdCopies.get(recoveredPath)).toBe(copy);
  expect(harness.trash).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
  expectDirtyOriginal(harness);
}

it("preserves a foreign file created at the reserved path during export", async () => {
  const h = await recoveryHarness();
  const gate = gateRuntime(h.runtime, "export-full");
  const replace = vi.fn(async () => true);
  const recovery = h.recover(replace);
  await gate.entered;
  const foreign = { file: new TestTFile(recoveredPath, 7), text: "foreign" };
  h.createdCopies.set(recoveredPath, foreign);
  gate.release();

  await expect(recovery).resolves.toMatchObject({ status: "failed" });
  expect(h.create).toHaveBeenCalledOnce();
  expectPreservedCopy(h, foreign, replace);
});

it.each(["modified", "replaced"] as const)(
  "rejects a recovery copy %s while worker verification is pending",
  async (change) => {
    const h = await recoveryHarness();
    const gate = gateRuntime(h.runtime, "verify-output");
    const replace = vi.fn(async () => true);
    const recovery = h.recover(replace);
    await gate.entered;
    const created = h.createdCopies.get(recoveredPath)!;
    if (change === "modified") {
      created.text = "foreign";
      created.file.stat.mtime += 1;
      created.file.stat.size = created.text.length;
    } else {
      h.createdCopies.set(recoveredPath, {
        file: new TestTFile(recoveredPath, created.file.stat.size),
        text: created.text,
      });
    }
    const foreign = h.createdCopies.get(recoveredPath);
    gate.release();

    await expect(recovery).resolves.toMatchObject({ status: "failed" });
    expectPreservedCopy(h, foreign, replace);
  },
);

it("preserves an unverified artifact and the dirty original when the host read fails", async () => {
  const h = await recoveryHarness();
  h.read.mockRejectedValueOnce(new Error("Host read failed"));
  const replace = vi.fn(async () => true);

  await expect(h.recover(replace)).resolves.toMatchObject({ status: "failed" });
  expect(h.create).toHaveBeenCalledOnce();
  const copy = h.createdCopies.get(recoveredPath);
  expect(copy?.file).toBe(await h.create.mock.results[0]!.value);
  expect(copy?.text).toBe(h.create.mock.calls[0]![1]);
  expectPreservedCopy(h, copy, replace);
});

it.each(["changed metadata", "identical length and metadata"] as const)(
  "preserves foreign bytes written before create resolves with %s",
  async (change) => {
    const h = await recoveryHarness();
    let foreignText = "";
    h.create.mockImplementationOnce(async (path, content) => {
      const created = await h.vault.create(path, content);
      const copy = h.createdCopies.get(path)!;
      foreignText =
        change === "changed metadata" ? "foreign" : content.replace("inkbook", "foreign");
      copy.text = foreignText;
      if (change === "changed metadata") {
        created.stat.mtime += 1;
        created.stat.size = foreignText.length;
      } else {
        expect(foreignText).not.toBe(content);
        expect(foreignText.length).toBe(content.length);
        expect(created.stat).toEqual({ ctime: 0, mtime: 0, size: content.length });
      }
      return created;
    });
    const replace = vi.fn(async () => true);

    await expect(h.recover(replace)).resolves.toMatchObject({ status: "failed" });
    const copy = h.createdCopies.get(recoveredPath);
    expect(copy?.file).toBe(await h.create.mock.results[0]!.value);
    expect(copy?.text).toBe(foreignText);
    expectPreservedCopy(h, copy, replace);
  },
);

it("preserves a replacement when the host read fails after creation", async () => {
  const h = await recoveryHarness();
  const foreign = { file: new TestTFile(recoveredPath, 7), text: "foreign" };
  h.read.mockImplementationOnce(async () => {
    h.createdCopies.set(recoveredPath, foreign);
    throw new Error("Host read failed after replacement");
  });
  const replace = vi.fn(async () => true);

  await expect(h.recover(replace)).resolves.toMatchObject({ status: "failed" });
  expect(h.create).toHaveBeenCalledOnce();
  expectPreservedCopy(h, foreign, replace);
});

it("invalidates the Markdown edit predicate when the verified copy changes", async () => {
  const h = await recoveryHarness();
  const entered = deferred();
  const release = deferred();
  cleanup.push(release.resolve);
  const predicate = vi.fn();
  const replace = vi.fn(async (_path: string, isCurrent: () => boolean) => {
    predicate(isCurrent());
    entered.resolve();
    await release.promise;
    const current = isCurrent();
    predicate(current);
    return current;
  });
  const recovery = h.session.resolveRecovery(
    "save-local-copy",
    { ...operation(), baseRevision: 8, operationId: 2 },
    { replaceMarkdownTarget: replace },
  );
  await entered.promise;
  const created = h.createdCopies.get(recoveredPath)!;
  created.file.stat.mtime += 1;
  release.resolve();

  await expect(recovery).resolves.toMatchObject({ status: "failed" });
  expect(predicate.mock.calls).toEqual([[true], [false]]);
  expect(h.trash).not.toHaveBeenCalled();
  expect(h.createdCopies.get(recoveredPath)).toBe(created);
  expectDirtyOriginal(h);
});
