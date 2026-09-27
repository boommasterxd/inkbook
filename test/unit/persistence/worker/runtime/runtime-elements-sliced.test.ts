import { expect, it } from "vitest";
import { stroke } from "../../../domain/schema/fixtures";
import { copySnapshotToRuntimeSliced } from "../../../../../src/persistence/worker/runtime/runtime-elements";
import { snapshot } from "./fixtures";

it("copies and validates long strokes in bounded chunks and reuses frozen samples", async () => {
  const source = stroke();
  const points = Array.from({ length: 12_000 }, (_, index) =>
    index % 3 === 2 ? 0.5 : Math.floor(index / 3),
  );
  Object.freeze(points);
  source.points = points;
  const copies = new WeakMap();
  let checkpoints = 0;
  const context = {
    checkpoint: async () => {
      checkpoints += 1;
    },
    signal: new AbortController().signal,
    workProfile: { inputByteLimit: 4_096, nodeLimit: 64, outputByteLimit: 16_384 },
  };
  const first = await copySnapshotToRuntimeSliced(
    { ...snapshot(), elements: [source] },
    context,
    copies,
  );
  expect(checkpoints).toBe(24);
  const copied = first.elements[0];
  expect(copied?.kind).toBe("stroke");
  if (copied?.kind !== "stroke") return;
  expect(copied.points).toBeInstanceOf(Float64Array);
  expect(copied.points).toEqual(new Float64Array(points));
  const again = await copySnapshotToRuntimeSliced(
    { ...snapshot(), elements: [source] },
    context,
    copies,
  );
  expect(again.elements[0]).toMatchObject({ points: copied.points });
  expect(checkpoints).toBe(24);
});

it("does not publish partial stroke copies when cancellation interrupts a chunk", async () => {
  const source = stroke();
  source.points = Array.from({ length: 12_000 }, (_, index) =>
    index % 3 === 2 ? 0.5 : Math.floor(index / 3),
  );
  const controller = new AbortController();
  let checkpoints = 0;
  await expect(
    copySnapshotToRuntimeSliced(
      { ...snapshot(), elements: [source] },
      {
        checkpoint: async () => {
          checkpoints += 1;
          if (checkpoints === 2) controller.abort();
          controller.signal.throwIfAborted();
        },
        signal: controller.signal,
        workProfile: { inputByteLimit: 4_096, nodeLimit: 64, outputByteLimit: 16_384 },
      },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(checkpoints).toBe(2);
});
