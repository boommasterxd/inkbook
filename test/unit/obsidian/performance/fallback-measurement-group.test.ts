import { expect, it, vi } from "vitest";
import * as runtime from "../../../../src/persistence/worker/runtime/public";
import * as serialization from "../../../../src/persistence/serialization/public";
import { PERSISTENCE_FALLBACK_SCENARIOS } from "../../../performance/comparison/persistence-fallback";

it("preserves all fallback phases and their shared CPU slice population", async () => {
  vi.stubEnv("INKBOOK_PERFORMANCE_MODE", "contracts");
  const scenario = PERSISTENCE_FALLBACK_SCENARIOS[0]!;
  const kernel = await scenario.create(
    {
      get<T>(module: string): T {
        return (module === "persistence/worker/runtime/public" ? runtime : serialization) as T;
      },
    },
    240,
  );
  try {
    const sequence = kernel.run() as AsyncGenerator<void, unknown, void>;
    let steps = 0;
    let next = await sequence.next();
    while (!next.done) {
      steps += 1;
      next = await sequence.next();
    }
    expect(steps).toBe(6);
    await kernel.verify(next.value);
    const samples = kernel.measurementSamples!(next.value, scenario.id);
    expect(samples.length).toBeGreaterThanOrEqual(100);
    expect(samples.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
    for (const member of PERSISTENCE_FALLBACK_SCENARIOS)
      expect(kernel.measurementSamples!(next.value, member.id)).toBe(samples);
    expect(() => kernel.measurementSamples!(next.value, "unknown")).toThrow("Unknown fallback");
  } finally {
    await kernel.dispose();
    vi.unstubAllEnvs();
  }
});
