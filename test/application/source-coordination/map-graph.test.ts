import { describe, expect, it } from "vitest";

import {
  createSourceGeneration,
  parseSha256Digest,
} from "../../../src/application/note-session";
import {
  appendSourceMapGraphNode,
  compactSourceMapPath,
  composeSourceMapCompositionRequest,
  createCompactedSourceMapNode,
  createSourceMapCompositionRequest,
  createSourceMapCompositionRequestFromSegments,
  createSourceMapGraphRoot,
  materializeSourceMapPath,
  sourceCoordinationRetainedBytes,
  sourceMapGraphNeedsCompaction,
  type SourceMapGraphNodeV1,
} from "../../../src/application/source-coordination/map-graph";
import { SOURCE_COORDINATION_LIMITS_V1 } from "../../../src/application/source-coordination/limits";
import { identifySourceOffsetMap } from "../../../src/application/source-coordination/offset-map";
import type {
  SourceOffsetMapIdentityV1,
  SourceSnapshotV1,
} from "../../../src/application/source-coordination/types";
import { TestStreamingDigestPort } from "./support";

/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact graph depths and lengths define the mapping limits. */

const DIGEST = parseSha256Digest("a".repeat(64));

function snapshot(
  markdown: string,
  retainedBytes = markdown.length * 2,
): SourceSnapshotV1 {
  return Object.freeze({
    markdown,
    retainedBytes,
    utf16Length: markdown.length,
    utf8Bytes: markdown.length,
  });
}

async function insertionIdentity(
  priorLength: number,
): Promise<SourceOffsetMapIdentityV1> {
  const result = await identifySourceOffsetMap(
    new TestStreamingDigestPort(),
    {
      spans: [
        {
          newFromUtf16: priorLength,
          newToUtf16: priorLength + 1,
          oldFromUtf16: priorLength,
          oldToUtf16: priorLength,
        },
      ],
    },
    priorLength,
    priorLength + 1,
  );
  if (!result.ok) throw new Error("Expected a valid insertion map.");
  return result.value;
}

async function graphWithDepth(
  depth: number,
): Promise<readonly [SourceMapGraphNodeV1, SourceMapGraphNodeV1]> {
  const rootResult = createSourceMapGraphRoot(
    createSourceGeneration(1),
    DIGEST,
    snapshot(""),
  );
  if (!rootResult.ok) throw new Error("Expected a valid graph root.");
  let node = rootResult.value;
  for (let index = 0; index < depth; index += 1) {
    const next = appendSourceMapGraphNode(
      node,
      createSourceGeneration(node.generation + 1),
      DIGEST,
      snapshot(`${node.snapshot.markdown}x`),
      await insertionIdentity(node.snapshot.utf16Length),
    );
    if (!next.ok) throw new Error("Expected a valid graph node.");
    node = next.value;
  }
  return [rootResult.value, node];
}

describe("persistent source map graph", () => {
  it("materializes at 32 nodes and rejects 33 without unrelated traversal", async () => {
    const [root, atLimit] = await graphWithDepth(
      SOURCE_COORDINATION_LIMITS_V1.maxHistoryMappingNodes,
    );
    const result = materializeSourceMapPath(root, atLimit);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.visitedNodes).toBe(
      SOURCE_COORDINATION_LIMITS_V1.maxHistoryMappingNodes,
    );

    const above = appendSourceMapGraphNode(
      atLimit,
      createSourceGeneration(atLimit.generation + 1),
      DIGEST,
      snapshot(`${atLimit.snapshot.markdown}x`),
      await insertionIdentity(atLimit.snapshot.utf16Length),
    );
    expect(above.ok).toBe(true);
    if (!above.ok) return;
    expect(materializeSourceMapPath(root, above.value)).toEqual({
      ok: false,
      code: "resource-limit",
    });
  });

  it("compacts one current path with bounded scratch and exact snapshot identity", async () => {
    const [root, target] = await graphWithDepth(8);
    const compacted = await compactSourceMapPath(
      new TestStreamingDigestPort(),
      root,
      target,
    );
    expect(compacted.ok).toBe(true);
    if (!compacted.ok) return;
    expect(compacted.value.parent).toBe(root);
    expect(compacted.value.snapshot).toBe(target.snapshot);
    expect(compacted.value.depth).toBe(1);
  });

  it("fails closed across a fork", async () => {
    const [root] = await graphWithDepth(0);
    const identity = await insertionIdentity(0);
    const left = appendSourceMapGraphNode(
      root,
      createSourceGeneration(2),
      DIGEST,
      snapshot("a"),
      identity,
    );
    const right = appendSourceMapGraphNode(
      root,
      createSourceGeneration(2),
      DIGEST,
      snapshot("b"),
      identity,
    );
    expect(left.ok && right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    expect(materializeSourceMapPath(left.value, right.value)).toEqual({
      ok: false,
      code: "stale-source",
    });
  });
});

describe("source map graph path validation", () => {
  it("returns an exact identity path and rejects a composition request across a fork", async () => {
    const [root] = await graphWithDepth(0);
    const identity = await insertionIdentity(0);
    const left = appendSourceMapGraphNode(
      root,
      createSourceGeneration(2),
      DIGEST,
      snapshot("a"),
      identity,
    );
    const right = appendSourceMapGraphNode(
      root,
      createSourceGeneration(2),
      DIGEST,
      snapshot("b"),
      identity,
    );
    if (!left.ok || !right.ok) throw new Error("Expected valid branches.");

    const same = materializeSourceMapPath(left.value, left.value);
    expect(same.ok && same.value.visitedNodes).toBe(0);
    expect(createSourceMapCompositionRequest(left.value, right.value)).toEqual({
      ok: false,
      code: "stale-source",
    });
    await expect(
      compactSourceMapPath(
        new TestStreamingDigestPort(),
        left.value,
        right.value,
      ),
    ).resolves.toEqual({
      ok: false,
      code: "stale-source",
    });
  });

  it("rejects stale append generations and length identities", async () => {
    const [root] = await graphWithDepth(0);
    const insertion = await insertionIdentity(0);
    const wrongPrior = Object.freeze({
      ...insertion,
      priorUtf16Length: 1,
    });
    const cases = [
      appendSourceMapGraphNode(
        root,
        createSourceGeneration(3),
        DIGEST,
        snapshot("a"),
        insertion,
      ),
      appendSourceMapGraphNode(
        root,
        createSourceGeneration(2),
        DIGEST,
        snapshot("a"),
        wrongPrior,
      ),
      appendSourceMapGraphNode(
        root,
        createSourceGeneration(2),
        DIGEST,
        snapshot("ab"),
        insertion,
      ),
    ];
    expect(cases).toEqual([
      { ok: false, code: "stale-source" },
      { ok: false, code: "stale-source" },
      { ok: false, code: "stale-source" },
    ]);
  });
});

describe("source map composition validation", () => {
  it("validates empty, oversized, disconnected, and empty composition inputs", async () => {
    const identity = await insertionIdentity(0);
    const segment = Object.freeze({
      offsetMap: identity.offsetMap,
      priorUtf16Length: identity.priorUtf16Length,
      replacementUtf16Length: identity.replacementUtf16Length,
    });
    expect(createSourceMapCompositionRequestFromSegments([])).toEqual({
      ok: false,
      code: "resource-limit",
    });
    expect(
      createSourceMapCompositionRequestFromSegments(
        Array.from(
          { length: SOURCE_COORDINATION_LIMITS_V1.maxHistoryMappingNodes + 1 },
          () => segment,
        ),
      ),
    ).toEqual({ ok: false, code: "resource-limit" });
    expect(
      createSourceMapCompositionRequestFromSegments([
        segment,
        Object.freeze({ ...segment, priorUtf16Length: 2 }),
      ]),
    ).toEqual({ ok: false, code: "stale-source" });
    expect(
      composeSourceMapCompositionRequest({
        priorUtf16Length: 0,
        replacementUtf16Length: 0,
        scratchByteLimit: 1,
        segments: [],
        wireVersion: 1,
      }),
    ).toEqual({ ok: true, value: { spans: [] } });
    expect(
      composeSourceMapCompositionRequest({
        priorUtf16Length: 0,
        replacementUtf16Length: 2,
        scratchByteLimit: 1,
        segments: [segment, Object.freeze({ ...segment, priorUtf16Length: 2 })],
        wireVersion: 1,
      }),
    ).toEqual({ ok: false, code: "stale-source" });
  });
});

describe("source map compaction failures", () => {
  it("fails compaction for invalid path maps and unavailable digest work", async () => {
    const [root] = await graphWithDepth(0);
    const invalidIdentity = Object.freeze({
      digest: DIGEST,
      encodedBytes: 1,
      offsetMap: Object.freeze({ spans: Object.freeze([]) }),
      priorUtf16Length: 0,
      replacementUtf16Length: 1,
    });
    const invalid = appendSourceMapGraphNode(
      root,
      createSourceGeneration(2),
      DIGEST,
      snapshot("a"),
      invalidIdentity,
    );
    if (!invalid.ok) throw new Error("Expected structural graph admission.");
    const next = appendSourceMapGraphNode(
      invalid.value,
      createSourceGeneration(3),
      DIGEST,
      snapshot("ab"),
      await insertionIdentity(1),
    );
    if (!next.ok) throw new Error("Expected structural graph admission.");
    await expect(
      compactSourceMapPath(new TestStreamingDigestPort(), root, next.value),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });

    const [validRoot, valid] = await graphWithDepth(2);
    await expect(
      compactSourceMapPath(
        {
          create: () => {
            throw new Error("Injected digest failure.");
          },
        },
        validRoot,
        valid,
      ),
    ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });
  });
});

describe("source map graph resource accounting", () => {
  it("preflights retained graph bytes before appending", async () => {
    const largeSnapshot = Object.freeze({
      markdown: "",
      retainedBytes: SOURCE_COORDINATION_LIMITS_V1.maxRetainedSourceBytes,
      utf16Length: 0,
      utf8Bytes: 0,
    });
    const root = createSourceMapGraphRoot(
      createSourceGeneration(1),
      DIGEST,
      largeSnapshot,
    );
    expect(root.ok).toBe(true);
    if (!root.ok) return;
    expect(
      appendSourceMapGraphNode(
        root.value,
        createSourceGeneration(2),
        DIGEST,
        snapshot("a"),
        await insertionIdentity(0),
      ),
    ).toEqual({ ok: false, code: "resource-limit" });
  });

  it("accounts structurally shared snapshots and maps exactly once", async () => {
    const rootResult = createSourceMapGraphRoot(
      createSourceGeneration(1),
      DIGEST,
      snapshot(""),
    );
    if (!rootResult.ok) throw new Error("Expected a valid graph root.");
    const identity = await insertionIdentity(0);
    const left = appendSourceMapGraphNode(
      rootResult.value,
      createSourceGeneration(2),
      DIGEST,
      snapshot("a"),
      identity,
    );
    const right = appendSourceMapGraphNode(
      rootResult.value,
      createSourceGeneration(2),
      DIGEST,
      snapshot("b"),
      identity,
    );
    if (!left.ok || !right.ok) throw new Error("Expected valid branches.");
    expect(sourceCoordinationRetainedBytes([left.value, right.value])).toBe(
      left.value.snapshot.retainedBytes +
        right.value.snapshot.retainedBytes +
        rootResult.value.snapshot.retainedBytes +
        identity.encodedBytes,
    );
  });

  it("requests compaction above, but not at, the retained byte limit", async () => {
    const [root] = await graphWithDepth(0);
    expect(
      sourceMapGraphNeedsCompaction(
        root,
        SOURCE_COORDINATION_LIMITS_V1.maxRetainedSourceBytes,
      ),
    ).toBe(false);
    expect(
      sourceMapGraphNeedsCompaction(
        root,
        SOURCE_COORDINATION_LIMITS_V1.maxRetainedSourceBytes + 1,
      ),
    ).toBe(true);
  });
});

describe("source map compacted-node validation", () => {
  it("rejects stale compacted identities and retained-byte overflow", async () => {
    const [root, replacement] = await graphWithDepth(1);
    const identity = await insertionIdentity(0);
    expect(createCompactedSourceMapNode(replacement, root, identity)).toEqual({
      ok: false,
      code: "stale-source",
    });
    expect(
      createCompactedSourceMapNode(
        root,
        replacement,
        Object.freeze({ ...identity, priorUtf16Length: 1 }),
      ),
    ).toEqual({ ok: false, code: "stale-source" });
    expect(
      createCompactedSourceMapNode(
        root,
        replacement,
        Object.freeze({ ...identity, replacementUtf16Length: 2 }),
      ),
    ).toEqual({ ok: false, code: "stale-source" });

    const fullRoot = createSourceMapGraphRoot(
      createSourceGeneration(1),
      DIGEST,
      snapshot("", SOURCE_COORDINATION_LIMITS_V1.maxRetainedSourceBytes),
    );
    if (!fullRoot.ok) throw new Error("Expected exact-limit graph root.");
    expect(
      createCompactedSourceMapNode(fullRoot.value, replacement, identity),
    ).toEqual({ ok: false, code: "resource-limit" });
  });
});
