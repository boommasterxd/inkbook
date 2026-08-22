import { describe, expect, it } from "vitest";

import { validateInkSnapshotV1 } from "../../../../src/domain/schema/public";
import { createAllElementSnapshot, createSnapshot, uuid } from "./fixtures";

describe("snapshot validation", () => {
  it("validates every version 1 element family with aggregate statistics", () => {
    const result = validateInkSnapshotV1(createAllElementSnapshot());

    expect(result).toMatchObject({
      ok: true,
      statistics: { elements: 12, strokes: 1, strokePoints: 3, connectedEndpoints: 0 },
    });
  });

  it("rejects duplicate IDs and highlights placed after content", () => {
    const snapshot = createAllElementSnapshot();
    snapshot.elements[1]!.id = snapshot.elements[0]!.id;
    expect(validateInkSnapshotV1(snapshot)).toMatchObject({
      ok: false,
      error: { code: "duplicate-id" },
    });

    const reordered = createAllElementSnapshot();
    reordered.elements.push(reordered.elements.shift()!);
    expect(validateInkSnapshotV1(reordered)).toMatchObject({
      ok: false,
      error: { code: "invalid-render-band-order" },
    });
  });

  it("validates semantic connection targets and endpoint positions", () => {
    const target = createAllElementSnapshot().elements.find(
      (element) => element.kind === "rectangle",
    )!;
    const line = {
      kind: "line" as const,
      id: uuid(20),
      createdAt: 20,
      rotation: 0,
      pivot: { x: 550, y: 250 },
      start: { x: 500, y: 250 },
      end: { x: 600, y: 250 },
      bend: null,
      startNode: "none" as const,
      endNode: "none" as const,
      style: {
        outlineColor: { type: "theme-text" as const },
        outlineWidth: 4 as const,
        outlineOpacity: 1,
        outlineStyle: "solid" as const,
      },
      startConnection: {
        targetId: target.id,
        anchor: { kind: "box" as const, position: "middle-right" as const },
      },
      endConnection: null,
    };
    expect(validateInkSnapshotV1(createSnapshot([target, line])).ok).toBe(true);

    line.start = { x: 499.998, y: 250 };
    expect(validateInkSnapshotV1(createSnapshot([target, line]))).toMatchObject({
      ok: false,
      error: { code: "connection-position-mismatch" },
    });

    line.startConnection.targetId = uuid(99);
    expect(validateInkSnapshotV1(createSnapshot([target, line]))).toMatchObject({
      ok: false,
      error: { code: "invalid-connection-target" },
    });
  });

  it("rejects unknown page properties, invalid bounds, and byte limits", () => {
    const unknown = createSnapshot() as unknown as Record<string, unknown>;
    (unknown.page as Record<string, unknown>).extra = true;
    expect(validateInkSnapshotV1(unknown)).toMatchObject({
      ok: false,
      error: { code: "unknown-property" },
    });

    const outside = createAllElementSnapshot();
    const rectangle = outside.elements.find((element) => element.kind === "rectangle");
    if (rectangle?.kind !== "rectangle") throw new Error("Missing rectangle fixture.");
    rectangle.x = -20;
    expect(validateInkSnapshotV1(outside)).toMatchObject({
      ok: false,
      error: { code: "invalid-range" },
    });

    expect(
      validateInkSnapshotV1(createSnapshot(), { totalInputBytes: 64 * 1024 * 1024 + 1 }),
    ).toMatchObject({
      ok: false,
      error: { code: "input-byte-limit-exceeded" },
    });
  });
});
