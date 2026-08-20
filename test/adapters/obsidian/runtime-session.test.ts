/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact history revisions and identifiers are protocol fixtures. */
import { describe, expect, it } from "vitest";

import {
  createHistoryEpoch,
  createAnnotationHistoryEntryV1,
  parseHistoryEntryId,
  parseOperationId,
} from "../../../src/domain/operations";
import { createSceneRevision } from "../../../src/domain/model";
import {
  createRuntimeSceneStateV1,
  type RuntimeSceneStateV1,
} from "../../../src/domain/scene";
import {
  createHostTransactionSequence,
  createSessionOrder,
  createSourceGeneration,
  parseHostEffectId,
  parseSha256Digest,
  type HostEffectDeliveryV1,
  type HostEffectEnvelopeV1,
  type SessionOrder,
} from "../../../src/application/note-session";
import type { PrepareHostEffectRequestV1 } from "../../../src/application/host-history/types";
import {
  appendSourceMapGraphNode,
  createSourceMapGraphRoot,
  identifySourceOffsetMap,
} from "../../../src/application/source-coordination";
import { RuntimeSessionHistoryV1 } from "../../../src/adapters/obsidian/runtime-session";
import { rectangleElement } from "../../domain/model/support";
import { POSITION_BINDING } from "../../domain/codecs/scene-support";
import {
  digestUtf8,
  TestStreamingDigestPort,
} from "../../application/source-coordination/support";
import {
  createHostHistoryHarness,
  createRecovery,
  historyDelivery,
  HOST_HISTORY_EDITOR_A,
  HOST_HISTORY_NOTE,
  HOST_HISTORY_PANE_A,
  invertHistoryEnvelope,
  prepareHostHistory,
  type RecoveryFixtureObservations,
  type RecoveryFixtureState,
} from "../../application/host-history/recovery-fixture";

const DIGEST = parseSha256Digest("0".repeat(64));
const BASE = Object.freeze({
  markdownPath: HOST_HISTORY_NOTE.vaultRelativeMarkdownPath,
  rawTextSha256: null,
  revision: null,
  vaultRelativePath: "Notes/history.inkbook.json",
});
const APPEARANCE = Object.freeze({
  background: "none" as const,
  contrast: "medium" as const,
  horizontalSpacing: "standard" as const,
});

describe("RuntimeSessionHistoryV1 external reload replacement", () => {
  it("atomically restores a reachable host effect and its scene", async () => {
    const runtime = createRuntimeHistory();
    const restored = await reachableHistorySnapshot();

    expect(
      runtime.replaceAfterExternalReload(restored.scene, {
        ...historyContext(),
        restoreSnapshot: restored.snapshot,
      }),
    ).toBe(true);
    expect(runtime.currentLease()).toEqual(restored.snapshot.lease);

    const undo = await requiredDelivery(
      runtime,
      historyDelivery(invertHistoryEnvelope(restored.envelope), 2),
    );
    expect(undo.kind).toBe("accepted");
    if (undo.kind !== "accepted") return;
    expect(undo.scene.revision).toBe(2);
    expect(undo.scene.elementsById.size).toBe(0);
    expect(
      runtime.sequenceHighWater(
        HOST_HISTORY_EDITOR_A,
        restored.envelope.historyEpoch,
      ),
    ).toBe(createHostTransactionSequence(2));
  });

  it("keeps the prior history unchanged when replacement construction rejects an invalid scene", async () => {
    const runtime = createRuntimeHistory();
    const prepared = await prepareRuntimeHistory(runtime, 4);
    const restored = await reachableHistorySnapshot();

    expect(
      runtime.replaceAfterExternalReload(invalidScene(), {
        ...historyContext(),
        restoreSnapshot: restored.snapshot,
      }),
    ).toBe(false);

    const forward = await requiredDelivery(
      runtime,
      historyDelivery(prepared.envelope, 1),
    );
    expect(forward.kind).toBe("accepted");
    if (forward.kind !== "accepted") return;
    expect(forward.scene.revision).toBe(1);
    expect(forward.scene.elementsById.size).toBe(1);
  });

  it("rejects an envelope owned by the prior coordinator after a successful swap", async () => {
    const runtime = createRuntimeHistory();
    const prior = await prepareRuntimeHistory(runtime, 7);
    const restored = await reachableHistorySnapshot();
    expect(
      runtime.replaceAfterExternalReload(restored.scene, {
        ...historyContext(),
        restoreSnapshot: restored.snapshot,
      }),
    ).toBe(true);

    await expect(
      requiredDelivery(runtime, historyDelivery(prior.envelope, 1)),
    ).resolves.toEqual({ kind: "rejected", reason: "entry-not-found" });
  });

  it("disposes the replacement coordinator and rejects later delivery", async () => {
    const runtime = createRuntimeHistory();
    const restored = await reachableHistorySnapshot();
    expect(
      runtime.replaceAfterExternalReload(restored.scene, {
        ...historyContext(),
        restoreSnapshot: restored.snapshot,
      }),
    ).toBe(true);

    runtime.disposeForReload(true);
    runtime.disposeForReload(true);

    await expect(
      requiredDelivery(
        runtime,
        historyDelivery(invertHistoryEnvelope(restored.envelope), 2),
      ),
    ).resolves.toEqual({ kind: "rejected", reason: "disposed" });
  });
});

describe("RuntimeSessionHistoryV1 source materialization", () => {
  it("materializes an actionable entry from its exact prepared source node", async () => {
    const runtime = createRuntimeHistory();
    const root = createSourceMapGraphRoot(
      createSourceGeneration(1),
      DIGEST,
      sourceSnapshot("abc"),
    );
    if (!root.ok) throw new Error("Expected a source root.");
    let current = root.value;
    runtime.bindSourceMaterialization(() => current);
    const prepared = await runtime.prepareDispatch(textBoundRequest(30));
    if (prepared.kind !== "prepared") {
      throw new Error("Expected a prepared text-bound entry.");
    }
    const map = await identifySourceOffsetMap(
      new TestStreamingDigestPort(),
      {
        spans: [
          {
            newFromUtf16: 0,
            newToUtf16: 1,
            oldFromUtf16: 0,
            oldToUtf16: 0,
          },
        ],
      },
      3,
      4,
    );
    if (!map.ok) throw new Error("Expected a source map.");
    const replacement = appendSourceMapGraphNode(
      current,
      createSourceGeneration(2),
      digestUtf8("xabc"),
      sourceSnapshot("xabc"),
      map.value,
    );
    if (!replacement.ok) throw new Error("Expected a replacement node.");
    current = replacement.value;

    const delivered = await requiredDelivery(
      runtime,
      historyDelivery(prepared.dispatch.envelope, 1),
    );
    expect(delivered.kind).toBe("accepted");
    if (delivered.kind !== "accepted") return;
    const binding = delivered.scene.elementsById.get(
      rectangleElement(30).elementId,
    )?.binding;
    expect(binding?.kind).toBe("text-position");
    if (binding?.kind === "text-position") {
      expect(binding.anchor.utf16Offset).toBe(3);
    }
  });
});

function createRuntimeHistory(): RuntimeSessionHistoryV1 {
  let order = 0;
  const observations = recoveryObservations();
  const recovery = createRecovery({}, recoveryState(), observations);
  const runtime = new RuntimeSessionHistoryV1(
    HOST_HISTORY_NOTE,
    recovery,
    { mode: "adjacent", version: 1 },
    (): SessionOrder => createSessionOrder(++order),
  );
  const initialSnapshot = createHostHistoryHarness().coordinator.snapshot();
  if (
    !runtime.initialize(emptyScene(), {
      ...historyContext(),
      restoreSnapshot: initialSnapshot,
    })
  ) {
    throw new Error("Expected runtime history initialization.");
  }
  return runtime;
}

async function reachableHistorySnapshot(): Promise<{
  readonly envelope: HostEffectEnvelopeV1;
  readonly scene: RuntimeSceneStateV1;
  readonly snapshot: ReturnType<
    ReturnType<typeof createHostHistoryHarness>["coordinator"]["snapshot"]
  >;
}> {
  const harness = createHostHistoryHarness();
  const prepared = await prepareHostHistory(
    harness.coordinator,
    HOST_HISTORY_PANE_A,
    1,
    0,
  );
  const delivered = await harness.coordinator.deliver(
    HOST_HISTORY_EDITOR_A,
    HOST_HISTORY_PANE_A,
    historyDelivery(prepared.envelope, 1),
  );
  if (delivered.kind !== "accepted") {
    throw new Error("Expected an accepted reachable Forward.");
  }
  return Object.freeze({
    envelope: prepared.envelope,
    scene: delivered.scene,
    snapshot: harness.coordinator.snapshot(),
  });
}

async function prepareRuntimeHistory(
  runtime: RuntimeSessionHistoryV1,
  elementIndex: number,
): Promise<{
  readonly envelope: HostEffectEnvelopeV1;
}> {
  const prepared = await runtime.prepareDispatch(prepareRequest(elementIndex));
  if (prepared.kind !== "prepared") {
    throw new Error("Expected runtime history preparation.");
  }
  return prepared.dispatch;
}

function prepareRequest(elementIndex: number): PrepareHostEffectRequestV1 {
  const element = rectangleElement(elementIndex);
  const historyEntry = createAnnotationHistoryEntryV1({
    forward: {
      elements: [
        {
          binding: element.binding,
          elementId: element.elementId,
          geometry: element.geometry,
          kind: element.kind,
          style: element.style,
        },
      ],
      kind: "create-elements",
      placement: {
        movedElementIds: [element.elementId],
        predecessorId: null,
        successorId: null,
      },
    },
    historyEntryId: parseHistoryEntryId(identifier("he", elementIndex)),
    historyEpoch: createHistoryEpoch(1),
  });
  if (!historyEntry.ok) throw new Error("Invalid history fixture.");
  return Object.freeze({
    effectId: parseHostEffectId(identifier("eff", elementIndex)),
    historyEntry: historyEntry.value,
    operationId: parseOperationId(identifier("op", elementIndex)),
    viewId: HOST_HISTORY_PANE_A,
  });
}

function textBoundRequest(elementIndex: number): PrepareHostEffectRequestV1 {
  const request = prepareRequest(elementIndex);
  const forward = request.historyEntry.forward;
  if (forward.kind !== "create-elements" || forward.elements[0] === undefined) {
    throw new Error("Expected a create-elements fixture.");
  }
  const historyEntry = createAnnotationHistoryEntryV1({
    forward: {
      ...forward,
      elements: [
        {
          ...forward.elements[0],
          binding: POSITION_BINDING,
        },
      ],
    },
    historyEntryId: request.historyEntry.historyEntryId,
    historyEpoch: request.historyEntry.historyEpoch,
  });
  if (!historyEntry.ok) throw new Error("Expected a valid text-bound entry.");
  return Object.freeze({ ...request, historyEntry: historyEntry.value });
}

function sourceSnapshot(markdown: string): {
  readonly markdown: string;
  readonly retainedBytes: number;
  readonly utf16Length: number;
  readonly utf8Bytes: number;
} {
  return Object.freeze({
    markdown,
    retainedBytes: markdown.length * 2,
    utf16Length: markdown.length,
    utf8Bytes: markdown.length,
  });
}

function historyContext(): {
  readonly base: typeof BASE;
  readonly sourceDigest: typeof DIGEST;
  readonly sourceGeneration: ReturnType<typeof createSourceGeneration>;
} {
  return Object.freeze({
    base: BASE,
    sourceDigest: DIGEST,
    sourceGeneration: createSourceGeneration(1),
  });
}

function emptyScene(): RuntimeSceneStateV1 {
  return createRuntimeSceneStateV1({
    elements: [],
    groups: [],
    noteAppearance: APPEARANCE,
    objectOrder: [],
    revision: createSceneRevision(0),
  });
}

function invalidScene(): RuntimeSceneStateV1 {
  const elementId = rectangleElement(0).elementId;
  return createRuntimeSceneStateV1({
    elements: [],
    groups: [],
    noteAppearance: APPEARANCE,
    objectOrder: [elementId, elementId],
    revision: createSceneRevision(1),
  });
}

function requiredDelivery(
  runtime: RuntimeSessionHistoryV1,
  delivery: HostEffectDeliveryV1,
): NonNullable<ReturnType<RuntimeSessionHistoryV1["deliver"]>> {
  const result = runtime.deliver(
    HOST_HISTORY_EDITOR_A,
    HOST_HISTORY_PANE_A,
    delivery,
  );
  if (result === null) throw new Error("Runtime history is unavailable.");
  return result;
}

function recoveryObservations(): RecoveryFixtureObservations {
  return {
    directionAttempts: [],
    expectedSceneRevisions: [],
    operationIds: [],
    prepareAttempts: [],
    recordedDirections: [],
  };
}

function recoveryState(): RecoveryFixtureState {
  return {
    directionFailures: 0,
    prepareFailures: 0,
    recordFailures: 0,
    recordRelease: Promise.resolve(),
    resolveRecordStarted: (): void => undefined,
  };
}

function identifier(prefix: string, index: number): string {
  return `${prefix}_${index.toString(16).padStart(26, "0")}`;
}
