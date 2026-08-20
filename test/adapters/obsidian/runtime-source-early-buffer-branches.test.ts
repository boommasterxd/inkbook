/* eslint-disable @typescript-eslint/no-magic-numbers -- Buffer limits and view fixtures are the behavior under test. */
import { describe, expect, it } from "vitest";

import {
  createHostTransactionSequence,
  createSourceGeneration,
  parseSha256Digest,
  parseViewId,
  type NoteSessionSnapshotV1,
  type NoteSessionTurnResultV1,
  type NoteSessionTurnV1,
  type NoteSessionV1,
} from "../../../src/application/note-session";
import type { SourceOffsetMapV1 } from "../../../src/application/source-coordination";
import type { EditorSourceTransitionV1 } from "../../../src/adapters/obsidian/editor-history/bridge";
import {
  publishRuntimeSourceReattachmentV1,
  RuntimeSourceEarlyBufferV1,
} from "../../../src/adapters/obsidian/runtime-source-early-buffer";
import type { RuntimePersistenceSourceV1 } from "../../../src/adapters/obsidian/runtime-persistence-source";

const DIGEST = parseSha256Digest("a".repeat(64));
const VIEW = parseViewId("view-a");
const EMPTY_MAP: SourceOffsetMapV1 = Object.freeze({
  spans: Object.freeze([]),
});

function transition(
  sequence: number,
  utf16Length = 0,
): EditorSourceTransitionV1 {
  const document = Object.freeze({
    sliceString: (): string => "",
    utf16Length,
  });
  return Object.freeze({
    hostTransactionSequence: createHostTransactionSequence(sequence),
    offsetMap: EMPTY_MAP,
    priorDocument: document,
    replacementDocument: document,
  });
}

function sourceSpy(): {
  readonly accepted: {
    readonly transition: EditorSourceTransitionV1;
    readonly viewId: string;
  }[];
  readonly source: RuntimePersistenceSourceV1;
} {
  const accepted: {
    readonly transition: EditorSourceTransitionV1;
    readonly viewId: string;
  }[] = [];
  const source = {
    accept: (viewId: string, value: EditorSourceTransitionV1): void => {
      accepted.push({ transition: value, viewId });
    },
    durableSource: { digest: DIGEST, generation: createSourceGeneration(1) },
  } as unknown as RuntimePersistenceSourceV1;
  return { accepted, source };
}

describe("runtime source early buffer", () => {
  it("forwards transitions immediately after a source is attached", () => {
    const buffer = new RuntimeSourceEarlyBufferV1(() => {
      throw new Error("Unexpected overflow");
    });
    const spy = sourceSpy();
    const value = transition(1);

    buffer.accept(VIEW, value, spy.source);

    expect(spy.accepted).toEqual([{ transition: value, viewId: VIEW }]);
  });

  it("drains pending transitions in order and resets retained accounting", () => {
    const buffer = new RuntimeSourceEarlyBufferV1(() => {
      throw new Error("Unexpected overflow");
    });
    const first = sourceSpy();
    const second = sourceSpy();
    const valueA = transition(1, 200_000);
    const valueB = transition(2, 200_000);

    buffer.accept(VIEW, valueA, null);
    buffer.accept(VIEW, valueB, null);
    buffer.drain(first.source);
    buffer.drain(second.source);

    expect(
      first.accepted.map((item) => item.transition.hostTransactionSequence),
    ).toEqual([1, 2]);
    expect(second.accepted).toEqual([]);
    buffer.accept(VIEW, valueA, null);
    buffer.drain(second.source);
    expect(second.accepted).toEqual([{ transition: valueA, viewId: VIEW }]);
  });

  it("reports transition-count overflow once until disposal", () => {
    let overflows = 0;
    const buffer = new RuntimeSourceEarlyBufferV1(() => {
      overflows += 1;
    });
    for (let index = 0; index < 65; index += 1) {
      buffer.accept(VIEW, transition(index + 1), null);
    }
    buffer.accept(VIEW, transition(100), null);

    expect(overflows).toBe(1);
    const spy = sourceSpy();
    buffer.drain(spy.source);
    expect(spy.accepted).toHaveLength(64);
    buffer.dispose();
    for (let index = 0; index < 65; index += 1) {
      buffer.accept(VIEW, transition(index + 200), null);
    }
    expect(overflows).toBe(2);
  });

  it("reports retained-byte overflow and allows a fresh buffer after disposal", () => {
    let overflows = 0;
    const buffer = new RuntimeSourceEarlyBufferV1(() => {
      overflows += 1;
    });
    const large = transition(1, 1_048_577);

    buffer.accept(VIEW, large, null);
    buffer.accept(VIEW, large, null);
    expect(overflows).toBe(1);
    buffer.dispose();
    buffer.accept(VIEW, large, null);
    expect(overflows).toBe(2);
  });
});

describe("runtime source reattachment publication", () => {
  it("ignores a missing session and an unavailable target digest", () => {
    publishRuntimeSourceReattachmentV1(null, null);
    const pending = sessionSpy({
      kind: "checkpoint-pending",
      generation: createSourceGeneration(2),
    });

    publishRuntimeSourceReattachmentV1(pending.session, null);

    expect(pending.published).toEqual([]);
  });

  const sourceStates: {
    readonly expected: typeof DIGEST;
    readonly source: NoteSessionSnapshotV1["source"];
  }[] = [
    {
      source: {
        kind: "durable",
        digest: DIGEST,
        generation: createSourceGeneration(1),
      },
      expected: DIGEST,
    },
    {
      source: { kind: "reattaching", targetDigest: DIGEST } as const,
      expected: DIGEST,
    },
  ];

  it.each(sourceStates)(
    "uses the current snapshot target for $source.kind",
    ({ source, expected }) => {
      const pending = sessionSpy(source);

      publishRuntimeSourceReattachmentV1(pending.session, null);

      expect(pending.published).toEqual([
        {
          ...pending.snapshot,
          source: { kind: "reattaching", targetDigest: expected },
        },
      ]);
    },
  );

  it("prefers an attached durable digest over the snapshot target", () => {
    const replacement = parseSha256Digest("b".repeat(64));
    const pending = sessionSpy({ kind: "reattaching", targetDigest: DIGEST });
    const source = {
      durableSource: { digest: replacement, generation: 3 },
    } as unknown as RuntimePersistenceSourceV1;

    publishRuntimeSourceReattachmentV1(pending.session, source);

    expect(pending.published[0]?.source).toEqual({
      kind: "reattaching",
      targetDigest: replacement,
    });
  });
});

function sessionSpy(source: NoteSessionSnapshotV1["source"]): {
  readonly pending: NoteSessionTurnV1[];
  readonly published: NoteSessionSnapshotV1[];
  readonly session: NoteSessionV1;
  readonly snapshot: NoteSessionSnapshotV1;
} {
  const snapshot = { source } as NoteSessionSnapshotV1;
  const pending: NoteSessionTurnV1[] = [];
  const published: NoteSessionSnapshotV1[] = [];
  const session = {
    enqueue: (turn: NoteSessionTurnV1): Promise<NoteSessionTurnResultV1> => {
      pending.push(turn);
      void turn.run({
        publish: (next): void => {
          published.push(next);
        },
        signal: new AbortController().signal,
        snapshot,
      });
      return Promise.resolve({ kind: "completed" });
    },
    snapshot,
  } as unknown as NoteSessionV1;
  return { pending, published, session, snapshot };
}
