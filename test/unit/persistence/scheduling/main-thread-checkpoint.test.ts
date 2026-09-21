import { afterEach, expect, it, vi } from "vitest";
import { createMainThreadDeadline } from "../../../../src/persistence/scheduling/main-thread-checkpoint";

afterEach(() => vi.restoreAllMocks());

it("uses a live deadline and falls back to four milliseconds for invalid budgets", () => {
  let now = 0;
  let budget = 8;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const deadline = createMainThreadDeadline(() => budget);
  now = 3;
  expect(deadline.exceeded()).toBe(false);
  budget = 2;
  expect(deadline.exceeded()).toBe(true);
  deadline.restart();
  expect(deadline.exceeded()).toBe(false);
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    budget = invalid;
    now = 6;
    expect(deadline.exceeded()).toBe(false);
    now = 7;
    expect(deadline.exceeded()).toBe(true);
  }
});
