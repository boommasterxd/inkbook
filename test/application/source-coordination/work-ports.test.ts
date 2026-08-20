import { describe, expect, it } from "vitest";

import type {
  CommandResultV1,
  Sha256Digest,
} from "../../../src/application/note-session";
import {
  SOURCE_COORDINATION_LIMITS_V1,
  createSourceSnapshot,
} from "../../../src/application/source-coordination/limits";
import { validateAndNormalizeSourceMapCompositionRequestV1 } from "../../../src/application/source-coordination/map-composition-fallback";
import { SourceDigestWorkOwnerV1 } from "../../../src/application/source-coordination/source-digest";
import type {
  SourceOffsetMapV1,
  SourceSnapshotV1,
} from "../../../src/application/source-coordination/types";
import {
  SourceMapWorkOwnerV1,
  type NormalizedSourceMapCompositionRequestV1,
  type SourceDigestWorkPortV1,
  type SourceDigestWorkSubmissionV1,
  type SourceMapWorkPortV1,
  type SourceMapWorkSubmissionV1,
} from "../../../src/application/source-coordination/work-ports";
import {
  TestStreamingDigestPort,
  digestUtf8,
  flushSourceMicrotasks,
} from "./support";

const EMPTY_MAP = Object.freeze({ spans: Object.freeze([]) });
const WORKER_SNAPSHOT_BYTES =
  SOURCE_COORDINATION_LIMITS_V1.sourceDigestWorkerAdmissionBytes;
const normalizedRequest = validateAndNormalizeSourceMapCompositionRequestV1({
  priorUtf16Length: 0,
  replacementUtf16Length: 0,
  scratchByteLimit: 1,
  segments: Object.freeze([
    Object.freeze({
      offsetMap: EMPTY_MAP,
      priorUtf16Length: 0,
      replacementUtf16Length: 0,
    }),
  ]),
  wireVersion: 1 as const,
});
if (!normalizedRequest.ok) throw new Error("Expected normalized map work.");
const REQUEST: NormalizedSourceMapCompositionRequestV1 =
  normalizedRequest.value;

interface PendingSubmission {
  cancelled: number;
  readonly reject: (error: unknown) => void;
  readonly resolve: (result: CommandResultV1<SourceOffsetMapV1>) => void;
}

class ControlledMapPort implements SourceMapWorkPortV1 {
  readonly pending: PendingSubmission[] = [];
  throwOnCancel = false;
  throwOnSubmit = false;

  submit(): SourceMapWorkSubmissionV1 {
    if (this.throwOnSubmit) throw new Error("Injected submit failure.");
    let reject!: (error: unknown) => void;
    let resolve!: (result: CommandResultV1<SourceOffsetMapV1>) => void;
    const completion = new Promise<CommandResultV1<SourceOffsetMapV1>>(
      (complete, fail) => {
        resolve = complete;
        reject = fail;
      },
    );
    const pending = { cancelled: 0, reject, resolve };
    this.pending.push(pending);
    return {
      cancel: (): void => {
        pending.cancelled += 1;
        if (this.throwOnCancel) throw new Error("Injected cancel failure.");
      },
      completion,
    };
  }
}

interface PendingDigestSubmission {
  cancelled: number;
  readonly resolve: (result: CommandResultV1<Sha256Digest>) => void;
}

class ControlledDigestPort implements SourceDigestWorkPortV1 {
  readonly pending: PendingDigestSubmission[] = [];

  submit(): SourceDigestWorkSubmissionV1 {
    let resolve!: (result: CommandResultV1<Sha256Digest>) => void;
    const completion = new Promise<CommandResultV1<Sha256Digest>>(
      (complete) => {
        resolve = complete;
      },
    );
    const pending = { cancelled: 0, resolve };
    this.pending.push(pending);
    return {
      cancel: (): void => {
        pending.cancelled += 1;
      },
      closeInput: (): void => undefined,
      completion,
      update: (): void => undefined,
    };
  }
}

function workerSnapshot(character: string): SourceSnapshotV1 {
  const result = createSourceSnapshot(character.repeat(WORKER_SNAPSHOT_BYTES));
  if (!result.ok) throw new Error("Expected an admitted source snapshot.");
  return result.value;
}

describe("source map work ownership", () => {
  it("supersedes one active submission without accepting its late completion", async () => {
    const owner = new SourceMapWorkOwnerV1();
    const port = new ControlledMapPort();
    const stale = owner.run(port, REQUEST);
    const current = owner.run(port, REQUEST);

    expect(port.pending[0]?.cancelled).toBe(1);
    await expect(stale).resolves.toEqual({
      ok: false,
      code: "stale-source",
    });
    port.pending[0]?.resolve({ ok: true, value: EMPTY_MAP });
    await flushSourceMicrotasks();
    port.pending[1]?.resolve({ ok: true, value: EMPTY_MAP });
    await expect(current).resolves.toEqual({ ok: true, value: EMPTY_MAP });
  });

  it("keeps work ownership isolated between two note owners", async () => {
    const firstOwner = new SourceMapWorkOwnerV1();
    const secondOwner = new SourceMapWorkOwnerV1();
    const firstPort = new ControlledMapPort();
    const secondPort = new ControlledMapPort();
    const first = firstOwner.run(firstPort, REQUEST);
    const second = secondOwner.run(secondPort, REQUEST);

    expect(firstPort.pending[0]?.cancelled).toBe(0);
    expect(secondPort.pending[0]?.cancelled).toBe(0);
    secondPort.pending[0]?.resolve({ ok: true, value: EMPTY_MAP });
    await expect(second).resolves.toEqual({ ok: true, value: EMPTY_MAP });
    expect(firstPort.pending[0]?.cancelled).toBe(0);
    firstPort.pending[0]?.resolve({ ok: true, value: EMPTY_MAP });
    await expect(first).resolves.toEqual({ ok: true, value: EMPTY_MAP });
  });

  it("releases ownership across cancel throws, submit throws, rejection, and disposal", async () => {
    const owner = new SourceMapWorkOwnerV1();
    const port = new ControlledMapPort();
    port.throwOnCancel = true;
    const stale = owner.run(port, REQUEST);
    const current = owner.run(port, REQUEST);
    await expect(stale).resolves.toEqual({
      ok: false,
      code: "stale-source",
    });
    port.pending[1]?.reject(new Error("Injected completion rejection."));
    await expect(current).resolves.toEqual({
      ok: false,
      code: "recovery-unavailable",
    });

    port.throwOnSubmit = true;
    await expect(owner.run(port, REQUEST)).resolves.toEqual({
      ok: false,
      code: "recovery-unavailable",
    });
    port.throwOnSubmit = false;
    const disposed = owner.run(port, REQUEST);
    owner.dispose();
    owner.dispose();
    expect(port.pending[2]?.cancelled).toBe(1);
    await expect(disposed).resolves.toEqual({ ok: false, code: "disposed" });
    port.pending[2]?.resolve({ ok: true, value: EMPTY_MAP });
    await flushSourceMicrotasks();
    await expect(owner.run(port, REQUEST)).resolves.toEqual({
      ok: false,
      code: "disposed",
    });
  });
});

describe("source digest work ownership", () => {
  it("supersedes one active digest and rejects its late completion", async () => {
    const port = new ControlledDigestPort();
    const owner = new SourceDigestWorkOwnerV1(
      new TestStreamingDigestPort(),
      port,
    );
    const stale = owner.digest(workerSnapshot("a"));
    const current = owner.digest(workerSnapshot("b"));

    expect(port.pending[0]?.cancelled).toBe(1);
    await expect(stale).resolves.toEqual({
      ok: false,
      code: "stale-source",
    });
    port.pending[0]?.resolve({ ok: true, value: digestUtf8("ignored") });
    await flushSourceMicrotasks();
    const currentDigest = digestUtf8("b".repeat(WORKER_SNAPSHOT_BYTES));
    port.pending[1]?.resolve({ ok: true, value: currentDigest });
    await expect(current).resolves.toEqual({
      ok: true,
      value: currentDigest,
    });
  });

  it("isolates digest owners and disposes active work idempotently", async () => {
    const firstPort = new ControlledDigestPort();
    const secondPort = new ControlledDigestPort();
    const firstOwner = new SourceDigestWorkOwnerV1(
      new TestStreamingDigestPort(),
      firstPort,
    );
    const secondOwner = new SourceDigestWorkOwnerV1(
      new TestStreamingDigestPort(),
      secondPort,
    );
    const first = firstOwner.digest(workerSnapshot("a"));
    const second = secondOwner.digest(workerSnapshot("b"));

    firstOwner.dispose();
    firstOwner.dispose();
    expect(firstPort.pending[0]?.cancelled).toBe(1);
    expect(secondPort.pending[0]?.cancelled).toBe(0);
    await expect(first).resolves.toEqual({ ok: false, code: "disposed" });
    const secondDigest = digestUtf8("b".repeat(WORKER_SNAPSHOT_BYTES));
    secondPort.pending[0]?.resolve({ ok: true, value: secondDigest });
    await expect(second).resolves.toEqual({
      ok: true,
      value: secondDigest,
    });
    await expect(firstOwner.digest(workerSnapshot("c"))).resolves.toEqual({
      ok: false,
      code: "disposed",
    });
  });
});
