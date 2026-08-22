import { describe, expect, it } from "vitest";

import type {
  ExportRequest,
  ExportSuccess,
  VaultBase,
} from "../../../../src/persistence/worker/protocol";
import { DocumentWorkerState } from "../../../../src/persistence/worker/state-machine";

interface ElementRecord {
  readonly id: string;
  readonly value: number;
}

type State = DocumentWorkerState<ElementRecord, { height: number }, { revision: number }>;
type Request = ExportRequest<ElementRecord, { height: number }, { revision: number }>;

const confirmed = (revision: number, outputHash = `hash-${revision}`): VaultBase => ({
  outputHash,
  revision,
  type: "confirmed",
});

const createState = (): State =>
  new DocumentWorkerState({
    confirmedBase: confirmed(0),
    editorRevision: 0,
    getElementId: ({ id }) => id,
    modelRevision: 0,
    sessionId: "session-a",
    workerEpoch: 7,
  });

const successFor = (request: Request, hash = `hash-${request.modelRevision}`): ExportSuccess => ({
  exportGeneration: request.exportGeneration,
  modelRevision: request.modelRevision,
  output: `<svg data-revision="${request.modelRevision}"/>`,
  outputHash: hash,
  sessionId: request.sessionId,
  type: "export-success",
  workerEpoch: request.workerEpoch,
});

const prepareRevisionOne = (state: State) => {
  state.recordCommit({
    changedElements: [{ id: "a", value: 1 }],
    modelRevision: 1,
  });
  const request = state.dispatchExport()!;
  expect(state.acceptExportResult(successFor(request))).toBe("prepared");
  return state.promotePreparedSuccessor()!;
};

const prepareWriteRecovery = () => {
  const state = createState();
  const active = prepareRevisionOne(state);
  state.beginWrite(active, confirmed(0));
  state.invalidateExecutor();
  return { active, recovery: state.verificationRecovery!, state };
};

describe("document worker export and save state", () => {
  it("dispatches generation-scoped exports and rejects unrelated results", () => {
    const state = createState();
    state.recordCommit({ changedElements: [{ id: "a", value: 1 }], modelRevision: 1 });
    const request = state.dispatchExport()!;

    expect(request).toMatchObject({
      baseModelRevision: 0,
      exportGeneration: 1,
      modelRevision: 1,
      sessionId: "session-a",
      workerEpoch: 7,
    });
    expect(
      state.acceptExportResult({ ...successFor(request), sessionId: "released-session" }),
    ).toBe("stale");
    expect(state.acceptExportResult(successFor(request))).toBe("prepared");
  });

  it("discards an export result that became obsolete while preserving its model baseline", () => {
    const state = createState();
    state.recordCommit({ changedElements: [{ id: "a", value: 1 }], modelRevision: 1 });
    const first = state.dispatchExport()!;
    state.recordCommit({ changedElements: [{ id: "a", value: 2 }], modelRevision: 2 });

    expect(state.acceptExportResult(successFor(first))).toBe("stale");
    expect(state.modelRevision).toBe(1);
    const second = state.dispatchExport()!;
    expect(second).toMatchObject({ baseModelRevision: 1, modelRevision: 2 });
  });

  it("makes an admitted save non-replaceable after writing begins", () => {
    const state = createState();
    const firstSave = prepareRevisionOne(state);
    expect(state.beginWrite(firstSave, confirmed(0))).toBe("started");

    state.recordCommit({ changedElements: [{ id: "a", value: 2 }], modelRevision: 2 });
    const secondExport = state.dispatchExport()!;
    expect(state.acceptExportResult(successFor(secondExport))).toBe("prepared");
    expect(state.activeSaveOperation?.saveOperationId).toBe(firstSave.saveOperationId);

    expect(state.beginReadBack(firstSave)).toBe(true);
    expect(state.confirmActiveReadBack(firstSave, confirmed(1))).toBe("confirmed");
    expect(state.confirmedBase).toEqual(confirmed(1));
    expect(state.dirty).toBe(true);
    expect(state.promotePreparedSuccessor()?.revision).toBe(2);
  });

  it("terminates an unwritten active save when the editor revision advances", () => {
    const state = createState();
    const active = prepareRevisionOne(state);
    state.recordCommit({ changedElements: [{ id: "b", value: 1 }], modelRevision: 2 });

    expect(state.beginWrite(active, confirmed(0))).toBe("superseded");
    expect(state.activeSaveOperation).toBeNull();
  });

  it("detects an exact-base mismatch before writing", () => {
    const state = createState();
    const active = prepareRevisionOne(state);
    expect(state.beginWrite(active, confirmed(99))).toBe("base-mismatch");
    expect(state.persistenceStatus).toBe("conflict");
  });

  it("rejects save phases routed from another session", () => {
    const state = createState();
    const active = prepareRevisionOne(state);
    const wrongSession = { ...active, sessionId: "session-b" };
    expect(state.beginWrite(wrongSession, confirmed(0))).toBe("superseded");
    expect(state.confirmActiveReadBack(wrongSession, confirmed(1))).toBe("stale");
    expect(state.activeSaveOperation).toEqual(active);
  });

  it("requires a full snapshot after an export failure", () => {
    const state = createState();
    state.recordCommit({ modelRevision: 1 });
    const request = state.dispatchExport()!;
    expect(
      state.acceptExportResult({
        error: { code: "invalid-order", retryable: true },
        exportGeneration: request.exportGeneration,
        modelRevision: request.modelRevision,
        sessionId: request.sessionId,
        type: "export-failure",
        workerEpoch: request.workerEpoch,
      }),
    ).toBe("failed");
    expect(() => state.dispatchExport()).toThrow("complete snapshot");
    expect(state.dispatchExport({ snapshot: { revision: 1 } })).toMatchObject({
      baseModelRevision: null,
      modelRevision: 1,
      type: "export-full",
    });
  });
});

describe("document worker failure recovery", () => {
  it("switches to fallback once and restarts only unwritten work", () => {
    const state = createState();
    prepareRevisionOne(state);
    const oldOperation = state.beginOperation("clipboard");

    expect(state.invalidateExecutor()).toBe("fallback-unwritten");
    expect(state.executorMode).toBe("fallback");
    expect(state.activeSaveOperation).toBeNull();
    expect(state.acceptsOperation(oldOperation)).toBe(false);
    expect(state.invalidateExecutor()).toBe("executor-failed");
    expect(state.executorMode).toBe("failed");
    expect(state.persistenceStatus).toBe("executor-failed");
  });

  it("retains immutable proof and confirms a save after an executor fails during write", () => {
    const { active, recovery, state } = prepareWriteRecovery();
    expect(recovery.proof).toEqual({
      outputHash: "hash-1",
      revision: 1,
      saveOperationId: active.saveOperationId,
    });
    expect(Object.isFrozen(recovery.proof)).toBe(true);
    expect(state.promotePreparedSuccessor()).toBeNull();
    expect(state.classifyRecoveryVerification(recovery.identity, { type: "unreadable" })).toBe(
      "retry-verification",
    );
    expect(state.verificationRecovery).not.toBeNull();
    expect(state.classifyRecoveryVerification(recovery.identity, confirmed(1))).toBe("confirmed");
    expect(state.confirmedBase).toEqual(confirmed(1));
    expect(state.dirty).toBe(false);
  });

  it("permits a retry only when verification still sees the prior confirmed base", () => {
    const { recovery, state } = prepareWriteRecovery();

    expect(state.classifyRecoveryVerification(recovery.identity, confirmed(0))).toBe("retry-write");
    expect(state.persistenceStatus).toBe("ready");
    expect(state.dirty).toBe(true);
  });

  it("classifies every other post-write result as an external conflict", () => {
    const { recovery, state } = prepareWriteRecovery();

    expect(state.classifyRecoveryVerification(recovery.identity, confirmed(9, "external"))).toBe(
      "conflict",
    );
    expect(state.persistenceStatus).toBe("conflict");
  });

  it("keeps a scheduled save after clipboard synchronization with a zero delta", () => {
    const state = createState();
    state.recordCommit({ changedElements: [{ id: "a", value: 1 }], modelRevision: 1 });
    state.acknowledgeModelSynchronization(1);
    expect(state.dispatchExport()).toMatchObject({
      baseModelRevision: 1,
      changedElements: [],
      modelRevision: 1,
      removedIds: [],
      type: "export-incremental",
    });
  });

  it("enforces monotonic revision and model invariants", () => {
    const state = createState();
    expect(() => state.recordCommit({ modelRevision: 2 })).toThrow("exactly once");
    expect(() => state.acknowledgeModelSynchronization(1)).toThrow("current editor revision");
    expect(
      () =>
        new DocumentWorkerState({
          confirmedBase: { type: "missing" },
          editorRevision: 1,
          getElementId: ({ id }: ElementRecord) => id,
          modelRevision: 2,
          sessionId: "session",
        }),
    ).toThrow(RangeError);
  });
});
