import { expect, it, vi } from "vitest";
import { fixture } from "../../../../fixtures/rendering/selection-run-paint";
import { fakeRectangleRecord } from "../../../../unit/rendering/scene/fakes";

function withoutMapIteration(read: () => unknown): unknown {
  const reject = (): never => {
    throw new Error("Memory accounting must not iterate maps.");
  };
  const spies = [
    vi.spyOn(Map.prototype, "values").mockImplementation(reject),
    vi.spyOn(Map.prototype, "entries").mockImplementation(reject),
    vi.spyOn(Map.prototype, "forEach").mockImplementation(reject),
    vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(reject),
  ];
  try {
    return read();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

it("reads exact incremental ownership counts without any map iteration", () => {
  const f = fixture();
  const runs = f.width;
  expect(f.svg.querySelectorAll("style")).toHaveLength(0);
  const entries = ["a", "b"].map((id) => f.mount(fakeRectangleRecord(id, 0, 0)));
  for (const entry of entries) runs.prepare(entry);
  runs.prepare(entries[0]!);
  expect(f.svg.querySelectorAll("style")).toHaveLength(1);
  expect(withoutMapIteration(() => runs.memoryUsage())).toMatchObject({
    trackedEntries: 2,
    trackedPaths: 2,
  });
  runs.release(entries[0]!);
  runs.release(entries[0]!);
  expect(withoutMapIteration(() => runs.memoryUsage())).toMatchObject({
    trackedEntries: 1,
    trackedPaths: 1,
  });
  runs.discard();
  expect(f.svg.querySelectorAll("style")).toHaveLength(0);
  expect(withoutMapIteration(() => runs.memoryUsage())).toMatchObject({
    trackedEntries: 0,
    trackedPaths: 0,
  });
  runs.release(entries[1]!);
  expect(runs.memoryUsage()).toMatchObject({
    trackedEntries: 0,
    trackedPaths: 0,
  });
});
