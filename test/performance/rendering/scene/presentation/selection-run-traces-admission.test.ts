import { expect, it, vi } from "vitest";
import { createInstrumentation } from "../../../../../src/rendering/scene/instrumentation";
import { SelectionRunTraces } from "../../../../../src/rendering/scene/presentation/selection-run-traces";
import { FakeDocument, FakeNode } from "../../../../unit/rendering/scene/fakes";

it("does not publish trace roots after shared admission expires and resumes without recreating the admitted suffix", () => {
  const document = new FakeDocument(),
    container = new FakeNode(document, "g"),
    stats = createInstrumentation();
  const traces = new SelectionRunTraces({
    container: container as never,
    node: () => undefined,
    instrumentation: stats,
  });
  const budget = { remainingRoots: 4 };
  let time = 1;
  expect(traces.prepare(1, () => time, budget)).toBe(false);
  expect(container.nodes).toHaveLength(0);
  expect(stats.domRootsPublished).toBe(0);
  time = 0;
  const original = document.createElementNS.bind(document);
  const create = vi.spyOn(document, "createElementNS").mockImplementation((...args) => {
    time += 1;
    return original(...args);
  });
  expect(traces.prepare(1, () => time, budget)).toBe(false);
  expect(container.nodes).toHaveLength(1);
  expect(stats.domRootsPublished).toBe(1);
  const suffix = container.nodes[0];
  expect(traces.prepare(3, () => time, budget)).toBe(true);
  expect(container.nodes).toHaveLength(2);
  expect(container.nodes[1]).toBe(suffix);
  expect(stats.domRootsPublished).toBe(2);
  expect(budget.remainingRoots).toBe(2);
  create.mockRestore();
  traces.release();
});
