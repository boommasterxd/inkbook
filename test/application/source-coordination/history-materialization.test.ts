import { describe, expect, it } from "vitest";

import {
  createSourceGeneration,
  parseSha256Digest,
  type CommandResultV1,
} from "../../../src/application/note-session";
import { HistoryMaterializationCoordinatorV1 } from "../../../src/application/source-coordination/history-materialization";
import {
  appendSourceMapGraphNode,
  createSourceMapGraphRoot,
  type SourceMapGraphNodeV1,
} from "../../../src/application/source-coordination/map-graph";
import { identifySourceOffsetMap } from "../../../src/application/source-coordination/offset-map";
import type { SourceSnapshotV1 } from "../../../src/application/source-coordination/types";
import { TestStreamingDigestPort } from "./support";

/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact source lengths define the materialization fixtures. */

const DIGEST = parseSha256Digest("a".repeat(64));

function snapshot(markdown: string): SourceSnapshotV1 {
  return Object.freeze({
    markdown,
    retainedBytes: markdown.length * 2,
    utf16Length: markdown.length,
    utf8Bytes: markdown.length,
  });
}

async function graphPair(): Promise<{
  readonly prior: SourceMapGraphNodeV1;
  readonly replacement: SourceMapGraphNodeV1;
}> {
  const prior = createSourceMapGraphRoot(
    createSourceGeneration(1),
    DIGEST,
    snapshot("a"),
  );
  const identity = await identifySourceOffsetMap(
    new TestStreamingDigestPort(),
    {
      spans: [
        {
          newFromUtf16: 1,
          newToUtf16: 2,
          oldFromUtf16: 1,
          oldToUtf16: 1,
        },
      ],
    },
    1,
    2,
  );
  if (!prior.ok || !identity.ok) throw new Error("Expected valid fixtures.");
  const replacement = appendSourceMapGraphNode(
    prior.value,
    createSourceGeneration(2),
    DIGEST,
    snapshot("ab"),
    identity.value,
  );
  if (!replacement.ok) throw new Error("Expected valid replacement node.");
  return { prior: prior.value, replacement: replacement.value };
}

describe("lazy history materialization", () => {
  it("passes the exact retained replacement snapshot to materialization", async () => {
    const graph = await graphPair();
    const coordinator = new HistoryMaterializationCoordinatorV1();
    const result = await coordinator.materialize({
      currentSource: () => graph.replacement,
      entryKey: "history-entry",
      input: { sourceGeneration: graph.prior, value: 1 },
      materialize: async (work) => {
        expect(work.replacementSnapshot).toBe(graph.replacement.snapshot);
        expect(work.visitedNodes).toBe(1);
        return { ok: true, value: work.value + 1 };
      },
    });
    expect(result).toEqual({ ok: true, value: 2 });
  });

  it("rejects stale, cancelled, and disposed completions", async () => {
    const graph = await graphPair();
    const coordinator = new HistoryMaterializationCoordinatorV1();
    let complete!: (value: CommandResultV1<number>) => void;
    const pending = coordinator.materialize<number, number>({
      currentSource: () => graph.replacement,
      entryKey: "history-entry",
      input: { sourceGeneration: graph.prior, value: 1 },
      materialize: () =>
        new Promise<CommandResultV1<number>>((resolve) => {
          complete = resolve;
        }),
    });
    coordinator.cancel("history-entry");
    complete({ ok: true, value: 2 });
    await expect(pending).resolves.toEqual({
      ok: false,
      code: "stale-source",
    });

    const disposed = coordinator.materialize({
      currentSource: () => graph.replacement,
      entryKey: "second-entry",
      input: { sourceGeneration: graph.prior, value: 1 },
      materialize: async () => ({ ok: true, value: 2 }),
    });
    coordinator.dispose();
    await expect(disposed).resolves.toEqual({ ok: false, code: "disposed" });
  });
});
