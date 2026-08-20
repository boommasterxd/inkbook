/* eslint-disable @typescript-eslint/no-magic-numbers -- Normative source and mapping limits are the tested contract. */
import { describe, expect, it } from "vitest";

import {
  createHostTransactionSequence,
  createSessionOrder,
  createSidecarRevision,
  createSourceGeneration,
  parseSha256Digest,
  parseSourceCheckpointId,
  parseViewId,
} from "../../../src/application/note-session";
import {
  appendSourceCheckpointFailClosed,
  type SourceCheckpointSchedulerV1,
} from "../../../src/application/source-coordination/checkpoints";
import {
  createMarkdownSourceCoordinator,
  type MarkdownSourceCoordinatorV1,
} from "../../../src/application/source-coordination/coordinator";
import { SOURCE_COORDINATION_LIMITS_V1 } from "../../../src/application/source-coordination/limits";
import {
  appendSourceMapGraphNode,
  createSourceMapGraphRoot,
  materializeSourceMapPath,
  type SourceMapGraphNodeV1,
} from "../../../src/application/source-coordination/map-graph";
import { composeSourceMapCompositionRequest } from "../../../src/application/source-coordination/map-graph";
import type {
  MarkdownSourceTransitionV1,
  SourceCheckpointOperationV1,
  SourceOffsetMapIdentityV1,
  SourceSnapshotV1,
} from "../../../src/application/source-coordination/types";
import type {
  SourceMapCompositionRequestV1,
  SourceMapWorkPortV1,
  SourceMapWorkSubmissionV1,
} from "../../../src/application/source-coordination/work-ports";
import {
  ImmediateSourceDigestWorkPort,
  TestStreamingDigestPort,
  digestUtf8,
} from "./support";

const DIGEST = parseSha256Digest("a".repeat(64));

function snapshot(
  length: number,
  retainedBytes = length * 2,
): SourceSnapshotV1 {
  return Object.freeze({
    markdown: "",
    retainedBytes,
    utf16Length: length,
    utf8Bytes: length,
  });
}

function identity(length: number): SourceOffsetMapIdentityV1 {
  return Object.freeze({
    digest: DIGEST,
    encodedBytes: 64,
    offsetMap: Object.freeze({ spans: Object.freeze([]) }),
    priorUtf16Length: length,
    replacementUtf16Length: length,
  });
}

function graphAtLimit(): readonly [SourceMapGraphNodeV1, SourceMapGraphNodeV1] {
  const root = createSourceMapGraphRoot(
    createSourceGeneration(1),
    DIGEST,
    snapshot(0),
  );
  if (!root.ok) throw new Error("Expected graph root admission.");
  let node = root.value;
  for (
    let index = 0;
    index < SOURCE_COORDINATION_LIMITS_V1.maxHistoryMappingNodes;
    index += 1
  ) {
    const next = appendSourceMapGraphNode(
      node,
      createSourceGeneration(node.generation + 1),
      DIGEST,
      snapshot(0),
      identity(0),
    );
    if (!next.ok) throw new Error("Expected graph node admission.");
    node = next.value;
  }
  return [root.value, node];
}

class ImmediateScheduler implements SourceCheckpointSchedulerV1 {
  lastCancelledHandle: object | number | null = null;

  cancel(handle: object | number): void {
    this.lastCancelledHandle = handle;
  }
  now(): number {
    return 0;
  }
  schedule(): number {
    return 1;
  }
}

class ControlledMapWorkPort implements SourceMapWorkPortV1 {
  readonly requests: SourceMapCompositionRequestV1[] = [];
  cancelled = 0;
  controlled = false;
  readonly pending: {
    readonly request: SourceMapCompositionRequestV1;
    readonly resolve: (
      result: ReturnType<typeof composeSourceMapCompositionRequest>,
    ) => void;
  }[] = [];

  submit(request: SourceMapCompositionRequestV1): SourceMapWorkSubmissionV1 {
    this.requests.push(request);
    if (!this.controlled || request.segments.length !== 32) {
      return {
        completion: Promise.resolve(
          composeSourceMapCompositionRequest(request),
        ),
        cancel: (): void => {
          this.cancelled += 1;
        },
      };
    }
    let resolveCompletion:
      | ((
          result: ReturnType<typeof composeSourceMapCompositionRequest>,
        ) => void)
      | undefined;
    const completion = new Promise<
      ReturnType<typeof composeSourceMapCompositionRequest>
    >((resolve) => {
      resolveCompletion = resolve;
    });
    if (resolveCompletion === undefined)
      throw new Error("Expected map-work resolver.");
    this.pending.push({ request, resolve: resolveCompletion });
    return {
      completion,
      cancel: (): void => {
        this.cancelled += 1;
      },
    };
  }
}

async function coordinatorAtMapLimit(
  workPort: ControlledMapWorkPort,
): Promise<MarkdownSourceCoordinatorV1> {
  let checkpoint = 0;
  let sessionOrder = 0;
  const created = await createMarkdownSourceCoordinator({
    createCheckpointId: () => {
      checkpoint += 1;
      return parseSourceCheckpointId(
        `scp_${String(checkpoint).padStart(26, "0")}`,
      );
    },
    digestPort: new TestStreamingDigestPort(),
    initialDigest: digestUtf8(""),
    initialGeneration: createSourceGeneration(1),
    initialMarkdown: "",
    nextSessionOrder: () => {
      sessionOrder += 1;
      return createSessionOrder(sessionOrder);
    },
    readBase: () => ({
      markdownPath: "notes/performance.md",
      rawTextSha256: DIGEST,
      revision: createSidecarRevision(1),
      vaultRelativePath: "notes/performance.inkbook.json",
    }),
    recoveryStore: {
      appendSourceCheckpoint: async () => ({ ok: true, value: undefined }),
    },
    scheduler: new ImmediateScheduler(),
    sourceDigestWorkPort: new ImmediateSourceDigestWorkPort(),
    sourceMapWorkPort: workPort,
  });
  if (!created.ok) throw new Error("Expected source coordinator.");
  for (let index = 0; index < 32; index += 1) {
    const result = await created.value.admit(insertion(index, "pane-a"));
    if (!result.ok) throw new Error("Expected transition admission.");
  }
  return created.value;
}

function insertion(
  priorLength: number,
  pane: "pane-a" | "pane-b",
): MarkdownSourceTransitionV1 {
  return {
    hostTransactionSequence: createHostTransactionSequence(priorLength + 1),
    offsetMap: {
      spans: [
        {
          newFromUtf16: priorLength,
          newToUtf16: priorLength + 1,
          oldFromUtf16: priorLength,
          oldToUtf16: priorLength,
        },
      ],
    },
    ownedMetadataChange: false,
    priorDigest: digestUtf8("x".repeat(priorLength)),
    priorGeneration: createSourceGeneration(priorLength + 1),
    replacementMarkdown: "x".repeat(priorLength + 1),
    viewId: parseViewId(pane),
  };
}

describe("source coordination performance contracts", () => {
  it("PERF-10K-CHECKPOINT-MAP fixes source, map, scratch, and retained-memory ceilings", () => {
    expect(SOURCE_COORDINATION_LIMITS_V1).toMatchObject({
      maxChangedSpans: 65_536,
      maxEncodedOffsetMapBytes: 4 * 1024 * 1024,
      maxHistoryMappingNodes: 32,
      maxMappingCompactionScratchBytes: 8 * 1024 * 1024,
      maxMarkdownUtf16Length: 8 * 1024 * 1024,
      maxMarkdownUtf8Bytes: 16 * 1024 * 1024,
      maxRetainedSourceBytes: 48 * 1024 * 1024,
      maxStreamingDigestChunkBytes: 256 * 1024,
    });
  });

  it("PERF-10K-HISTORY-MATERIALIZE reports the exact 32-node structural budget", () => {
    const [root, atLimit] = graphAtLimit();
    const materialized = materializeSourceMapPath(root, atLimit);
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    expect(materialized.value.visitedNodes).toBe(32);
  });
});

describe("source coordination bounded work", () => {
  it("PERF-10K-CHECKPOINT-MAP compacts before node 33 becomes unmaterializable", async () => {
    const workPort = new ControlledMapWorkPort();
    const coordinator = await coordinatorAtMapLimit(workPort);
    const before = workPort.requests.length;

    await expect(
      coordinator.admit(insertion(32, "pane-a")),
    ).resolves.toMatchObject({
      ok: true,
    });
    const compaction = workPort.requests
      .slice(before)
      .find(({ segments }) => segments.length === 32);
    expect(compaction?.scratchByteLimit).toBe(8 * 1024 * 1024);
    expect(coordinator.currentSource.depth).toBe(2);
  });

  it("PERF-10K-CHECKPOINT-MAP rejects a superseded admission before duplicate compaction work", async () => {
    const workPort = new ControlledMapWorkPort();
    const coordinator = await coordinatorAtMapLimit(workPort);
    workPort.controlled = true;
    const first = coordinator.admit(insertion(32, "pane-a"));
    const second = coordinator.admit(insertion(32, "pane-b"));
    for (let turn = 0; turn < 10 && workPort.pending.length < 1; turn += 1) {
      await Promise.resolve();
    }
    expect(workPort.pending).toHaveLength(1);
    const currentWork = workPort.pending[0];
    if (currentWork === undefined) {
      throw new Error("Expected current compaction.");
    }
    expect(workPort.cancelled).toBe(0);
    await expect(first).resolves.toEqual({ ok: false, code: "stale-source" });
    currentWork.resolve(
      composeSourceMapCompositionRequest(currentWork.request),
    );
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it("PERF-10K-CHECKPOINT-MAP cancels pending compaction and rejects its stale completion after disposal", async () => {
    const workPort = new ControlledMapWorkPort();
    const coordinator = await coordinatorAtMapLimit(workPort);
    workPort.controlled = true;
    const admission = coordinator.admit(insertion(32, "pane-a"));
    for (let turn = 0; turn < 10 && workPort.pending.length === 0; turn += 1) {
      await Promise.resolve();
    }
    expect(workPort.pending).toHaveLength(1);

    coordinator.dispose();
    expect(workPort.cancelled).toBe(1);
    const pending = workPort.pending[0];
    if (pending === undefined) throw new Error("Expected pending compaction.");
    pending.resolve(composeSourceMapCompositionRequest(pending.request));
    await expect(admission).resolves.toEqual({ ok: false, code: "disposed" });
  });

  it("PERF-10K-CHECKPOINT-APPEND waits for injected durable append completion", async () => {
    let resolveAppend:
      | ((value: { readonly ok: true; readonly value: undefined }) => void)
      | undefined;
    const append = new Promise<{
      readonly ok: true;
      readonly value: undefined;
    }>((resolve) => {
      resolveAppend = resolve;
    });
    const checkpoint = {} as SourceCheckpointOperationV1;
    let settled = false;
    const completion = appendSourceCheckpointFailClosed(
      {
        appendSourceCheckpoint: (value) => {
          expect(value).toBe(checkpoint);
          return append;
        },
      },
      checkpoint,
    ).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    resolveAppend?.({ ok: true, value: undefined });
    await expect(completion).resolves.toEqual({ ok: true, value: undefined });
  });

  it("PERF-10K-CHECKPOINT-MAP rejects retained bytes above the 48 MiB preflight", () => {
    const atLimit = createSourceMapGraphRoot(
      createSourceGeneration(1),
      DIGEST,
      snapshot(0, SOURCE_COORDINATION_LIMITS_V1.maxRetainedSourceBytes),
    );
    const above = createSourceMapGraphRoot(
      createSourceGeneration(1),
      DIGEST,
      snapshot(0, SOURCE_COORDINATION_LIMITS_V1.maxRetainedSourceBytes + 1),
    );
    expect(atLimit.ok).toBe(true);
    expect(above).toEqual({ ok: false, code: "resource-limit" });
  });
});
