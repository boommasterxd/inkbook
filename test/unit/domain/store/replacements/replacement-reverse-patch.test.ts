import { describe, expect, it } from "vitest";

import type { LineElementV1 } from "../../../../../src/domain/schema/public";
import {
  createReverseConnectionPatchesTimeSliced,
  type ReverseConnectionPatch,
} from "../../../../../src/domain/store/replacements/replacement-reverse-patch";
import type { ReplacementCandidate } from "../../../../../src/domain/store/replacements/replacement-planner";
import type { ElementRecord, EndpointReference } from "../../../../../src/domain/store/types";

import { connectedLine, rectangle } from "../fixtures";

describe("time-sliced reverse-connection replacement patches", () => {
  it("prepares connection fanout without forced yields or source mutation", async () => {
    const scenario = reversePatchScenario();
    let yields = 0;

    const prepared = await createReverseConnectionPatchesTimeSliced(
      scenario.source,
      scenario.candidates,
      scenario.replacements,
      {
        shouldYield: () => false,
        yieldControl: async () => {
          yields += 1;
          expect(scenario.source.get(scenario.oldTargetId)).toHaveLength(512);
          expect(scenario.source.get(scenario.newTargetId)).toBeUndefined();
        },
      },
    );

    if (prepared === "cancelled") throw new Error("Expected reverse patches.");
    expect(yields).toBe(0);
    expect(patchFor(prepared.patches, scenario.oldTargetId)?.references).toEqual([]);
    expect(patchFor(prepared.patches, scenario.newTargetId)?.references).toHaveLength(512);
  });

  it("cancels during bounded fanout work without changing the source", async () => {
    const scenario = reversePatchScenario();
    let yields = 0;

    const prepared = await createReverseConnectionPatchesTimeSliced(
      scenario.source,
      scenario.candidates,
      scenario.replacements,
      {
        isCancelled: () => yields === 3,
        shouldYield: () => yields < 3,
        yieldControl: async () => {
          yields += 1;
        },
      },
    );

    expect(prepared).toBe("cancelled");
    expect(scenario.source.get(scenario.oldTargetId)).toHaveLength(512);
    expect(scenario.source.get(scenario.newTargetId)).toBeUndefined();
  });

  it("checks cancellation inside fanout traversal even with budget remaining", async () => {
    const scenario = reversePatchScenario();
    const source = new Map(scenario.source);
    const references = source.get(scenario.oldTargetId)!;
    let cancelled = false;
    let reads = 0;
    let yields = 0;
    source.set(
      scenario.oldTargetId,
      new Proxy(references, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^(0|[1-9]\d*)$/u.test(key)) {
            reads += 1;
            if (reads === 129) cancelled = true;
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      }),
    );

    const prepared = await createReverseConnectionPatchesTimeSliced(
      source,
      scenario.candidates,
      scenario.replacements,
      {
        isCancelled: () => cancelled,
        shouldYield: () => false,
        yieldControl: async () => {
          yields += 1;
        },
      },
    );

    expect(prepared).toBe("cancelled");
    expect(reads).toBe(129);
    expect(yields).toBe(0);
    expect(references).toHaveLength(512);
    expect(source.get(scenario.newTargetId)).toBeUndefined();
  });
});

function reversePatchScenario(): {
  readonly candidates: readonly ReplacementCandidate[];
  readonly newTargetId: string;
  readonly oldTargetId: string;
  readonly replacements: readonly ElementRecord[];
  readonly source: ReadonlyMap<string, readonly EndpointReference[]>;
} {
  const oldTarget = rectangle();
  const newTarget = rectangle("00000000-0000-4000-8000-000000000099", 700, 100);
  const candidates: ReplacementCandidate[] = [];
  const replacements: ElementRecord[] = [];
  const references: EndpointReference[] = [];
  for (let index = 0; index < 512; index += 1) {
    const current = lineRecord(oldTarget, index);
    const replacement = moveConnection(current, newTarget.id);
    candidates.push({
      current,
      domains: ["geometry", "connection"],
      element: replacement.element as LineElementV1,
    });
    replacements.push(replacement);
    references.push(Object.freeze({ endpoint: "start", linearId: current.element.id }));
  }
  return {
    candidates,
    newTargetId: newTarget.id,
    oldTargetId: oldTarget.id,
    replacements,
    source: new Map([[oldTarget.id, references]]),
  };
}

function lineRecord(target: ReturnType<typeof rectangle>, index: number): ElementRecord {
  const element = {
    ...connectedLine(target),
    createdAt: index + 2,
    id: `00000000-0000-4000-8001-${index.toString().padStart(12, "0")}`,
  };
  return {
    bounds: { maxX: 2, maxY: 2, minX: 0, minY: 0 },
    element,
    geometryVersion: 0,
    paintVersion: 0,
  };
}

function moveConnection(current: ElementRecord, targetId: string): ElementRecord {
  const element = current.element as LineElementV1;
  return {
    ...current,
    element: {
      ...element,
      startConnection: { anchor: { kind: "box", position: "top-left" }, targetId },
    },
  };
}

function patchFor(
  patches: readonly ReverseConnectionPatch[],
  targetId: string,
): ReverseConnectionPatch | undefined {
  return patches.find((patch) => patch.targetId === targetId);
}
