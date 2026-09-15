import { expect, it } from "vitest";

import { IncrementalDocumentSerializer } from "../../../src/persistence/serialization/public";
import { createSnapshot } from "../../unit/persistence/serialization/fixtures";
import { expectTiming } from "../timing-assertions";
import { createRetainedCapacityRectangle } from "./fixtures";

it("updates retained serializer capacity without rescanning unchanged geometry", async ({
  annotate,
}) => {
  const elements = Array.from({ length: 20_000 }, (_, index) =>
    createRetainedCapacityRectangle(index + 1),
  );
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.reset(createSnapshot(elements)).ok).toBe(true);
  const target = elements[0]!;
  const started = performance.now();

  for (let revision = 8; revision < 108; revision += 1) {
    const offset = revision % 2;
    const result = serializer.applyDelta({
      baseModelRevision: revision - 1,
      changedElements: [{ ...target, pivot: { x: 150 + offset, y: 150 }, x: 100 + offset }],
      modelRevision: revision,
    });
    expect(result).toEqual({ ok: true, value: undefined });
  }
  const durationMs = performance.now() - started;

  await annotate(`100 retained-capacity updates=${durationMs.toFixed(3)} ms`, "performance");
  expectTiming(durationMs, 500);
});
