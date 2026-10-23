import { expect, it, vi } from "vitest";
import { WorkspaceEditorCoordinator } from "../../../../../src/editor/session/workspace-editor-coordinator";
import {
  DocumentWorkerRuntime,
  type DocumentRuntimePort,
  type DocumentRuntimeRequest,
} from "../../../../../src/persistence/worker/runtime/public";
import {
  createVaultSessionFactory,
  documentFromSnapshot,
  emptySnapshot,
  operation,
  rectangle,
  recoveryCopyVaultHarness,
  TestTFile,
} from "./vault-session-fixtures";

function createHarness(failures: readonly string[]) {
  let document = documentFromSnapshot();
  const file = new TestTFile("drawings/ink.svg", document.bytes.byteLength);
  const copies = recoveryCopyVaultHarness({ file, getDocument: () => document });
  const createCopy = vi.spyOn(copies.vault, "create");
  const trash = vi.spyOn(copies.vault, "trash");
  const requests: { epoch: number; request: DocumentRuntimeRequest }[] = [];
  const terminations: ReturnType<typeof vi.fn>[] = [];
  const failed = new Set(failures);
  let holdReload: (() => Promise<void>) | undefined;
  const create = vi.fn(async (sessionId: string, workerEpoch: number) => {
    const core = new DocumentWorkerRuntime({ sessionId, workerEpoch });
    let terminal = false;
    const terminate = vi.fn(() => core.terminate());
    const port: DocumentRuntimePort = {
      execute: async (request, observer) => {
        requests.push({ epoch: workerEpoch, request });
        if (terminal || failed.delete(`${workerEpoch}/${request.type}`)) {
          terminal = true;
          return Promise.reject(new Error("worker crashed"));
        }
        const result = await core.execute(request, observer);
        if (request.type === "unlock" && request.identity.purpose === "recovery")
          await holdReload?.();
        return result;
      },
      terminate,
    };
    terminations.push(terminate);
    return port;
  });
  const factory = createVaultSessionFactory(copies.vault, create);
  const session = factory.create({ documentId: file.path, sessionId: "session-1" });
  return {
    ...copies,
    createCopy,
    trash,
    create,
    requests,
    terminations,
    session,
    holdReload: (hold: () => Promise<void>) => {
      holdReload = hold;
    },
    fail: (failure: string) => failed.add(failure),
    invalidate: () => {
      document = { svg: "invalid", bytes: new TextEncoder().encode("invalid") };
      file.stat.size = document.bytes.byteLength;
    },
    external: () => {
      document = documentFromSnapshot({ ...emptySnapshot(), elements: [rectangle()], revision: 9 });
      file.stat.size = document.bytes.byteLength;
    },
  };
}

it("cancels the actual external reload before adopting a model after a presentation handoff", async () => {
  const fixture = createHarness([]);
  const presentations = { cancelGesture: vi.fn(), disableInput: vi.fn(), release: vi.fn() };
  const coordinator = new WorkspaceEditorCoordinator({
    createSessionId: () => "session-1",
    presentations,
    sessions: { create: () => fixture.session },
  });
  const first = { documentId: "drawings/ink.svg", attachmentId: "first", attachmentGeneration: 1 };
  const second = { ...first, attachmentId: "second" };
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = vi.fn();
  fixture.holdReload(async () => {
    started();
    await held;
  });
  try {
    coordinator.mountAttachment(first);
    expect(await coordinator.requestActivation(first).outcome).toMatchObject({ kind: "activated" });
    const original = fixture.session.editorContext!;
    const cancel = vi.spyOn(fixture.session, "cancelOperation");
    fixture.external();
    const reloading = coordinator.notifyExternalChange(first.documentId);
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    coordinator.mountAttachment(second);
    expect(await coordinator.requestActivation(second).outcome).toMatchObject({
      disposition: "same-document-handoff",
    });
    const attached = fixture.session.editorContext!;
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        attachment: { attachmentId: "first", attachmentGeneration: 1 },
        baseRevision: 7,
      }),
    );
    release();
    expect(await reloading).toBe("ignored");
    expect(fixture.session.editorContext!.model).toBe(original.model);
    expect(fixture.session.editorContext!.history).toBe(original.history);
    expect(attached.model).toBe(fixture.session.editorContext!.model);
    expect(attached.history).toBe(fixture.session.editorContext!.history);
    expect(original.model.store.get(rectangle().id)).toBeUndefined();
    expect(fixture.session.getSnapshot().revision).toBe(7);
    expect(coordinator.getSnapshot().current?.attachment?.attachmentId).toBe("second");
    expect(presentations.release).toHaveBeenCalledOnce();
    expect(fixture.create).toHaveBeenCalledOnce();
  } finally {
    release();
    coordinator.dispose();
  }
});

it.each(["export-full", "verify-output"])(
  "replaces a failed recovery %s executor without creating a second copy",
  async (stage) => {
    const fixture = createHarness([`1/${stage}`]);
    try {
      await fixture.session.unlock(operation());
      const { model, history } = fixture.session.editorContext!;
      history.create([rectangle()]);
      expect(
        await fixture.session.resolveRecovery("save-local-copy", {
          ...operation(),
          operationId: 2,
          baseRevision: 8,
        }),
      ).toMatchObject({
        status: "confirmed",
        workerEpoch: 2,
        savedPath: "drawings/ink-recovered-1.svg",
      });
      expect(fixture.create).toHaveBeenCalledTimes(2);
      expect(fixture.createCopy).toHaveBeenCalledOnce();
      expect(fixture.trash).not.toHaveBeenCalled();
      expect(fixture.session.editorContext).toEqual({ model, history });
      expect(fixture.session.getSnapshot()).toMatchObject({
        dirty: true,
        revision: 8,
        confirmedRevision: 7,
      });
      expect(fixture.terminations[0]).toHaveBeenCalledOnce();
      const restarted = fixture.requests
        .filter(({ epoch }) => epoch === 2)
        .map(({ request }) => request.type);
      expect(restarted).toEqual(
        stage === "export-full" ? ["export-full", "verify-output"] : ["verify-output"],
      );
    } finally {
      fixture.session.dispose();
    }
    expect(fixture.terminations[1]).toHaveBeenCalledOnce();
  },
);

it("shares the exhausted native restart budget with recovery fallback", async () => {
  const fixture = createHarness(["1/export-full", "2/export-full"]);
  try {
    await fixture.session.unlock(operation());
    fixture.session.documentModel!.commitElement(rectangle());
    expect(
      await fixture.session.resolveRecovery("save-local-copy", {
        ...operation(),
        operationId: 2,
        baseRevision: 8,
      }),
    ).toMatchObject({ status: "confirmed", workerEpoch: 3 });
    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(fixture.createCopy).toHaveBeenCalledOnce();
  } finally {
    fixture.session.dispose();
  }
});

it.each([false, true])("retries a read-only external reload, automatic=%s", async (automatic) => {
  const fixture = createHarness([]);
  try {
    await fixture.session.unlock(operation());
    fixture.external();
    fixture.fail("1/unlock");
    const result = automatic
      ? await fixture.session.notifyExternalChange({ ...operation(), operationId: 2 })
      : await fixture.session.resolveRecovery("reload-external", {
          ...operation(),
          operationId: 2,
          baseRevision: 7,
        });
    expect(result).toMatchObject(
      automatic
        ? { outcome: "reloaded", workerEpoch: 2, operationId: 2 }
        : { status: "confirmed", workerEpoch: 2 },
    );
    expect(fixture.session.documentModel?.store.get(rectangle().id)).toBeDefined();
    expect(fixture.session.getSnapshot()).toMatchObject({
      dirty: false,
      revision: 9,
      workerEpoch: 2,
    });
    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(fixture.createCopy).not.toHaveBeenCalled();
  } finally {
    fixture.session.dispose();
  }
});

it("restores the authoritative dirty model through replacement after a failed reload", async () => {
  const fixture = createHarness(["1/export-full"]);
  try {
    await fixture.session.unlock(operation());
    const context = fixture.session.editorContext!;
    context.history.create([rectangle()]);
    fixture.invalidate();
    expect(
      await fixture.session.resolveRecovery("reload-external", {
        ...operation(),
        operationId: 2,
        baseRevision: 8,
      }),
    ).toMatchObject({ status: "failed", workerEpoch: 2 });
    expect(fixture.session.editorContext).toEqual(context);
    expect(fixture.session.getSnapshot()).toMatchObject({
      dirty: true,
      revision: 8,
      workerEpoch: 2,
    });
    expect(
      fixture.requests.filter(({ epoch }) => epoch === 2).map(({ request }) => request.type),
    ).toEqual(["export-full"]);
    expect(await context.model.encodeClipboard(new Set([rectangle().id]))).not.toBeNull();
    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(fixture.createCopy).not.toHaveBeenCalled();
  } finally {
    fixture.session.dispose();
  }
});

it.each(["cancellation", "disposal"])(
  "cleans the one artifact after %s wins replacement",
  async (stop) => {
    const fixture = createHarness(["1/verify-output"]);
    try {
      await fixture.session.unlock(operation());
      fixture.session.documentModel!.commitElement(rectangle());
      const construct = fixture.create.getMockImplementation()!;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      fixture.create.mockImplementation(async (sessionId, epoch) => {
        const candidate = await construct(sessionId, epoch);
        await held;
        return candidate;
      });
      const recoveryOperation = { ...operation(), operationId: 2, baseRevision: 8 };
      const recovering = fixture.session.resolveRecovery("save-local-copy", recoveryOperation);
      await vi.waitFor(() => expect(fixture.create).toHaveBeenCalledTimes(2));
      if (stop === "disposal") fixture.session.dispose();
      else fixture.session.cancelOperation(recoveryOperation);
      release();
      expect(await recovering).toMatchObject({ status: "failed" });
      expect(fixture.createCopy).toHaveBeenCalledOnce();
      expect(fixture.trash).toHaveBeenCalledOnce();
      expect(fixture.createdCopies.size).toBe(0);
      expect(fixture.requests.filter(({ epoch }) => epoch === 2)).toEqual([]);
      if (stop === "cancellation")
        expect(fixture.session.getSnapshot()).toMatchObject({ dirty: true, revision: 8 });
      else expect(fixture.session.documentModel).toBeUndefined();
    } finally {
      fixture.session.dispose();
    }
  },
);
