/* eslint-disable @typescript-eslint/no-magic-numbers -- Fixture counters identify source generations and values. */
import { describe, expect, it } from "vitest";

import {
  commandFailure,
  commandSuccess,
  createSourceGeneration,
  parseSha256Digest,
  type CommandResultV1,
} from "../../../src/application/note-session";
import {
  appendSourceMapGraphNode,
  createSourceMapGraphRoot,
  HistoryMaterializationCoordinatorV1,
  type SourceMapGraphNodeV1,
} from "../../../src/application/source-coordination";
import type { HistoryMaterializationWorkV1 } from "../../../src/application/source-coordination/history-materialization";
import type { HistoryMaterializationWorkPortV1 } from "../../../src/application/source-coordination/work-ports";
import type { SourceSnapshotV1 } from "../../../src/application/source-coordination/types";
import { identifySourceOffsetMap } from "../../../src/application/source-coordination/offset-map";
import { TestStreamingDigestPort } from "./support";

const DIGEST = parseSha256Digest("a".repeat(64));

function snapshot(markdown: string): SourceSnapshotV1 {
  return Object.freeze({
    markdown,
    retainedBytes: markdown.length * 2,
    utf16Length: markdown.length,
    utf8Bytes: markdown.length,
  });
}

async function graphFixture(): Promise<{
  readonly root: SourceMapGraphNodeV1;
  readonly child: SourceMapGraphNodeV1;
  readonly other: SourceMapGraphNodeV1;
}> {
  const rootResult = createSourceMapGraphRoot(
    createSourceGeneration(1),
    DIGEST,
    snapshot("a"),
  );
  if (!rootResult.ok) throw new Error("Expected a graph root.");
  const mapResult = await identifySourceOffsetMap(
    new TestStreamingDigestPort(),
    { spans: [] },
    1,
    1,
  );
  if (!mapResult.ok) throw new Error("Expected an identity map.");
  const childResult = appendSourceMapGraphNode(
    rootResult.value,
    createSourceGeneration(2),
    DIGEST,
    snapshot("a"),
    mapResult.value,
  );
  if (!childResult.ok) throw new Error("Expected a graph child.");
  const otherResult = createSourceMapGraphRoot(
    createSourceGeneration(7),
    DIGEST,
    snapshot("other"),
  );
  if (!otherResult.ok) throw new Error("Expected an unrelated root.");
  return {
    child: childResult.value,
    other: otherResult.value,
    root: rootResult.value,
  };
}

describe("history materialization admission and direct work", () => {
  it("rejects disposed coordinators and malformed work choices", async () => {
    const graph = await graphFixture();
    const coordinator = new HistoryMaterializationCoordinatorV1();

    await expect(
      coordinator.materialize({
        currentSource: () => graph.child,
        entryKey: "none",
        input: { sourceGeneration: graph.root, value: 1 },
      }),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });
    await expect(
      coordinator.materialize({
        currentSource: () => graph.child,
        entryKey: "both",
        input: { sourceGeneration: graph.root, value: 1 },
        materialize: async () => commandSuccess(2),
        workPort: new ControlledWorkPort(),
      }),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });

    coordinator.dispose();
    coordinator.dispose();
    expect(coordinator.cancel("none")).toBeUndefined();
    await expect(
      coordinator.materialize({
        currentSource: () => graph.child,
        entryKey: "disposed",
        input: { sourceGeneration: graph.root, value: 1 },
        materialize: async () => commandSuccess(2),
      }),
    ).resolves.toEqual({ ok: false, code: "disposed" });
  });

  it("rejects a source path that is not descended from the input", async () => {
    const graph = await graphFixture();
    const coordinator = new HistoryMaterializationCoordinatorV1();

    await expect(
      coordinator.materialize({
        currentSource: () => graph.other,
        entryKey: "unrelated",
        input: { sourceGeneration: graph.root, value: 1 },
        materialize: async () => commandSuccess(2),
      }),
    ).resolves.toEqual({ ok: false, code: "stale-source" });
  });

  it("returns direct success and failure results, including an undefined result", async () => {
    const graph = await graphFixture();
    const coordinator = new HistoryMaterializationCoordinatorV1();
    const success = await coordinator.materialize({
      currentSource: () => graph.child,
      entryKey: "direct-success",
      input: { sourceGeneration: graph.root, value: 2 },
      materialize: async (work) => commandSuccess(work.value * 2),
    });
    expect(success).toEqual({ ok: true, value: 4 });

    const failure = commandFailure<number>("recovery-unavailable");
    await expect(
      coordinator.materialize({
        currentSource: () => graph.child,
        entryKey: "direct-failure",
        input: { sourceGeneration: graph.root, value: 2 },
        materialize: async () => failure,
      }),
    ).resolves.toBe(failure);

    await expect(
      coordinator.materialize({
        currentSource: () => graph.child,
        entryKey: "direct-undefined",
        input: { sourceGeneration: graph.root, value: 2 },
        materialize: async () => undefined as never,
      }),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });
  });
});

describe("history materialization worker ownership", () => {
  it("submits immutable work, returns worker results, and clears its canceller", async () => {
    const graph = await graphFixture();
    const port = new ControlledWorkPort<number, number>();
    const coordinator = new HistoryMaterializationCoordinatorV1();
    const pending = coordinator.materialize({
      currentSource: () => graph.child,
      entryKey: "worker",
      input: { sourceGeneration: graph.root, value: 3 },
      workPort: port,
    });

    expect(port.work[0]?.visitedNodes).toBe(1);
    expect(port.work[0]?.priorSnapshot).toBe(graph.root.snapshot);
    expect(port.work[0]?.replacementSnapshot).toBe(graph.child.snapshot);
    port.resolve(0, commandSuccess(7));
    await expect(pending).resolves.toEqual({ ok: true, value: 7 });
    coordinator.cancel("worker");
    expect(port.cancelled).toBe(0);
  });

  it("preserves worker failures and rejects a completion after the source changes", async () => {
    const graph = await graphFixture();
    const port = new ControlledWorkPort<number, number>();
    const coordinator = new HistoryMaterializationCoordinatorV1();
    const failed = coordinator.materialize({
      currentSource: () => graph.child,
      entryKey: "worker-failure",
      input: { sourceGeneration: graph.root, value: 3 },
      workPort: port,
    });
    const failure = commandFailure<number>("recovery-unavailable");
    port.resolve(0, failure);
    await expect(failed).resolves.toBe(failure);

    let current = graph.child;
    const stale = coordinator.materialize({
      currentSource: () => current,
      entryKey: "changed-source",
      input: { sourceGeneration: graph.root, value: 3 },
      workPort: port,
    });
    current = graph.other;
    port.resolve(1, commandSuccess(8));
    await expect(stale).resolves.toEqual({ ok: false, code: "stale-source" });
  });

  it("cancels the active entry and reports stale completion", async () => {
    const graph = await graphFixture();
    const port = new ControlledWorkPort<number, number>();
    const coordinator = new HistoryMaterializationCoordinatorV1();
    const pending = coordinator.materialize({
      currentSource: () => graph.child,
      entryKey: "cancelled",
      input: { sourceGeneration: graph.root, value: 3 },
      workPort: port,
    });

    coordinator.cancel("cancelled");
    expect(port.cancelled).toBe(1);
    port.resolve(0, commandSuccess(8));
    await expect(pending).resolves.toEqual({ ok: false, code: "stale-source" });
    coordinator.cancel("missing");
  });

  it("turns a lifecycle disposal into a disposed result and cancels once", async () => {
    const graph = await graphFixture();
    const port = new ControlledWorkPort<number, number>();
    const coordinator = new HistoryMaterializationCoordinatorV1();
    const pending = coordinator.materialize({
      currentSource: () => graph.child,
      entryKey: "disposed-worker",
      input: { sourceGeneration: graph.root, value: 3 },
      workPort: port,
    });

    coordinator.dispose();
    coordinator.dispose();
    expect(port.cancelled).toBe(1);
    port.resolve(0, commandSuccess(8));
    await expect(pending).resolves.toEqual({ ok: false, code: "disposed" });
  });
});

class ControlledWorkPort<T, R> implements HistoryMaterializationWorkPortV1<
  T,
  R
> {
  public cancelled = 0;
  public readonly work: {
    readonly priorSnapshot: SourceSnapshotV1;
    readonly replacementSnapshot: SourceSnapshotV1;
    readonly visitedNodes: number;
  }[] = [];
  readonly #resolvers: ((result: CommandResultV1<R>) => void)[] = [];

  public submit(work: HistoryMaterializationWorkV1<T>): {
    readonly completion: Promise<CommandResultV1<R>>;
    cancel(): void;
  } {
    this.work.push({
      priorSnapshot: work.priorSnapshot,
      replacementSnapshot: work.replacementSnapshot,
      visitedNodes: work.visitedNodes,
    });
    let resolve!: (result: CommandResultV1<R>) => void;
    const completion = new Promise<CommandResultV1<R>>((settle) => {
      resolve = settle;
    });
    this.#resolvers.push(resolve);
    return {
      cancel: (): void => {
        this.cancelled += 1;
      },
      completion,
    };
  }

  public resolve(index: number, result: CommandResultV1<R>): void {
    const resolve = this.#resolvers[index];
    if (resolve === undefined) throw new Error("Missing worker completion.");
    resolve(result);
  }
}
