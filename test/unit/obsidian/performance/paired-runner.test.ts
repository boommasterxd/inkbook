import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ComparisonKernel,
  ComparisonScenario,
} from "../../../performance/comparison/contracts";
import { runPairedScenarios } from "../../../performance/comparison/paired-runner";

let time = 0;
beforeEach(() => {
  time = 0;
  vi.spyOn(performance, "now").mockImplementation(() => time);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(override: Partial<ComparisonScenario> = {}) {
  const reference = {
    get<T>(): T {
      return "reference" as T;
    },
  };
  const candidate = {
    get<T>(): T {
      return "candidate" as T;
    },
  };
  const order: string[] = [];
  const dispose = { reference: vi.fn(), candidate: vi.fn() };
  const scenario: ComparisonScenario = {
    id: "measured",
    modules: [],
    covers: [],
    execution: "sync",

    warmupOperations: 1,
    create(implementation) {
      const side = implementation.get<"reference" | "candidate">("");
      return {
        reset() {
          time += 100;
        },
        run() {
          order.push(side);
          time += side === "reference" ? 3 : 6;
          return side;
        },
        verify(result) {
          expect(result).toBe(side);
          time += 100;
        },
        dispose: dispose[side],
      };
    },
    ...override,
  };
  return {
    options: { scenarios: [scenario], reference, candidate, refreshRate: 240 },
    order,
    dispose,
    scenario,
  };
}

describe("paired comparison execution", () => {
  it.each([0, 1, 2])(
    "retains exact atomic ABBA/BAAB blocks in fresh-process round %s",
    async (roundIndex) => {
      const input = fixture();
      const [result] = await runPairedScenarios({ ...input.options, roundIndex });
      expect(result?.blocks).toHaveLength(2);
      expect(input.order.slice(0, 4)).toEqual(["reference", "candidate", "candidate", "reference"]);
      const expected: string[] = [];
      for (let block = 0; block < 2; block += 1) {
        const sides =
          block % 2 === 0
            ? ["reference", "candidate", "candidate", "reference"]
            : ["candidate", "reference", "reference", "candidate"];
        expected.push(...sides);
        expect(result?.blocks[block]?.measurements.map(({ side }) => side)).toEqual(sides);
        for (const measurement of result!.blocks[block]!.measurements) {
          expect(measurement.samplesMs).toEqual(measurement.side === "reference" ? [3] : [6]);
        }
      }
      expect(input.order.slice(4)).toEqual(expected);
      expect(result?.referenceMs).toBe(3);
      expect(result?.candidateMs).toBe(6);
      expect(input.dispose.reference).toHaveBeenCalledOnce();
      expect(input.dispose.candidate).toHaveBeenCalledOnce();
    },
  );
});

describe("paired comparison measurement timing", () => {
  it("does not await synchronous callbacks inside the measurement interval", async () => {
    const input = fixture({
      create() {
        return {
          run() {
            time += 2;
            queueMicrotask(() => {
              time += 1000;
            });
          },
          verify() {},
          dispose() {},
        };
      },
    });
    const [result] = await runPairedScenarios(input.options);
    expect(result?.referenceMs).toBe(2);
    expect(result?.candidateMs).toBe(2);
  });

  it("awaits async completion and excludes asynchronous reset/verification", async () => {
    const input = fixture({
      execution: "async",
      create() {
        return {
          async reset() {
            await Promise.resolve();
            time += 100;
          },
          async run() {
            time += 2;
            await Promise.resolve();
            time += 3;
            return 7;
          },
          async verify(value) {
            expect(value).toBe(7);
            await Promise.resolve();
            time += 200;
          },
          dispose() {},
        };
      },
    });
    const [result] = await runPairedScenarios(input.options);
    expect(result?.referenceMs).toBe(5);
  });

  it("copies all internal phase samples before a later reset mutates their array", async () => {
    const samples: number[] = [];
    const input = fixture({
      create() {
        return {
          reset() {
            samples.length = 0;
          },
          run() {
            time += 100;
            samples.push(1, 4, 7);
          },
          measurementSamples: () => samples,
          verify() {},
          dispose() {},
        };
      },
    });
    const [result] = await runPairedScenarios(input.options);
    expect(
      result?.blocks
        .flatMap(({ measurements }) => measurements)
        .every(({ samplesMs }) => samplesMs.join() === "1,4,7,1,4,7"),
    ).toBe(true);
    expect(result?.referenceMs).toBe(12);
  });
});

describe("paired comparison failure cleanup", () => {
  it.each(["reset", "run", "verify", "measurementSamples"] as const)(
    "disposes both after %s fails",
    async (phase) => {
      const input = fixture();
      const create = input.scenario.create.bind(input.scenario);
      input.scenario.create = (implementation, hz) => {
        const kernel = create(implementation, hz) as ComparisonKernel;
        kernel[phase] = () => {
          throw new Error("operation failed");
        };
        return kernel;
      };
      await expect(runPairedScenarios(input.options)).rejects.toThrow("operation failed");
      expect(input.dispose.reference).toHaveBeenCalledOnce();
      expect(input.dispose.candidate).toHaveBeenCalledOnce();
    },
  );

  it("disposes reference when candidate construction fails", async () => {
    const input = fixture();
    const create = input.scenario.create.bind(input.scenario);
    input.scenario.create = (implementation, hz) => {
      if (implementation === input.options.candidate) throw new Error("construction failed");
      return create(implementation, hz);
    };
    await expect(runPairedScenarios(input.options)).rejects.toThrow("construction failed");
    expect(input.dispose.reference).toHaveBeenCalledOnce();
    expect(input.dispose.candidate).not.toHaveBeenCalled();
  });

  it("still disposes reference when candidate disposal fails", async () => {
    const input = fixture();
    input.dispose.candidate.mockImplementation(() => {
      throw new Error("dispose failed");
    });
    await expect(runPairedScenarios(input.options)).rejects.toThrow("dispose failed");
    expect(input.dispose.reference).toHaveBeenCalledOnce();
  });
});

describe("paired comparison input bounds", () => {
  it.for([[], [-1], [NaN], [Infinity], Array.from({ length: 1_000_001 }, () => 1)])(
    "rejects invalid sample population %#",
    async (samples) => {
      const input = fixture({
        create: () => ({ run() {}, verify() {}, dispose() {}, measurementSamples: () => samples }),
      });
      await expect(runPairedScenarios(input.options)).rejects.toThrow("invalid wall-clock");
    },
  );

  it.each([0, -1, 101, 1.1, NaN, Infinity])(
    "rejects invalid operation count %s before creating a kernel",
    async (count) => {
      for (const field of ["warmupOperations"] as const) {
        const create = vi.fn();
        const input = fixture({ [field]: count, create });
        await expect(runPairedScenarios(input.options)).rejects.toThrow("operation count");
        expect(create).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects combined measurement samples beyond the retained bound", async () => {
    const samples = Array.from({ length: 600_000 }, () => 0.000001);
    const input = fixture({
      statistics: [{ kind: "mean", population: "operations", minimumOperations: 8 }],
      create: () => ({
        run() {
          time += 250;
        },
        verify() {},
        dispose() {},
        measurementSamples: () => samples,
      }),
    });
    await expect(runPairedScenarios(input.options)).rejects.toThrow("sample bound exceeded");
  });

  it("rejects promise and custom thenable returns from synchronous kernels", async () => {
    for (const run of [
      () => Promise.resolve(1),
      () => Promise.reject(new Error("async rejection")),
      () => ({ then: (resolve: (value: number) => void) => resolve(1) }),
    ]) {
      const input = fixture({ create: () => ({ run, verify() {}, dispose() {} }) });
      await expect(runPairedScenarios(input.options)).rejects.toThrow("Synchronous");
    }
  });
});

describe("paired synchronous lifecycle scheduling", () => {
  it("alternates warmup order and performs one symmetric exposed GC per block", async () => {
    const input = fixture({ warmupOperations: 4 });
    const gcPositions: number[] = [];
    const collect = vi.fn(() => {
      gcPositions.push(input.order.length);
    });
    vi.stubGlobal("gc", collect);
    await runPairedScenarios(input.options);
    expect(input.order.slice(0, 8)).toEqual([
      "reference",
      "candidate",
      "candidate",
      "reference",
      "reference",
      "candidate",
      "candidate",
      "reference",
    ]);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(gcPositions).toEqual([8, 12]);
  });

  it("does not insert microtasks between synchronous operation lifecycle calls", async () => {
    const events: string[] = [];
    const input = fixture({
      create() {
        return {
          reset() {
            events.push("reset");
          },
          run() {
            events.push("run");
            queueMicrotask(() => events.push("microtask"));
            time += 1;
          },
          verify() {
            events.push("verify");
          },
          dispose() {},
        };
      },
    });
    await runPairedScenarios(input.options);
    const firstMicrotask = events.indexOf("microtask");
    // The fixed 250-operation warmup for each side executes without per-operation microtasks.
    expect(events.slice(0, firstMicrotask)).toEqual(
      Array.from({ length: 500 }, () => ["reset", "run", "verify"]).flat(),
    );
  });

  it("awaits async reset and verify around a synchronous measured callback", async () => {
    let ready = false;
    let valueVerified = true;
    const input = fixture({
      create() {
        return {
          async reset() {
            expect(valueVerified).toBe(true);
            await Promise.resolve();
            time += 100;
            ready = true;
            valueVerified = false;
          },
          run() {
            expect(ready).toBe(true);
            ready = false;
            time += 4;
            return 7;
          },
          async verify(value) {
            expect(value).toBe(7);
            await Promise.resolve();
            time += 100;
            valueVerified = true;
          },
          dispose() {},
        };
      },
    });
    const [result] = await runPairedScenarios(input.options);
    expect(result?.referenceMs).toBe(4);
    expect(result?.candidateMs).toBe(4);
    expect(valueVerified).toBe(true);
  });
});

describe("paired operation work aggregation", () => {
  it.each([
    { candidateSlices: [1, 1, 1, 1, 1, 1, 1, 1], expectedWork: 8 },
    { candidateSlices: [2, 2, 2, 2, 2, 2, 2, 2], expectedWork: 16 },
  ])(
    "scores total operation work despite extra slices: $expectedWork ms",
    async ({ candidateSlices, expectedWork }) => {
      const input = fixture();
      input.scenario.create = (implementation) => {
        const candidate = implementation === input.options.candidate;
        return {
          run() {},
          verify() {},
          dispose() {},
          measurementSamples: () => (candidate ? candidateSlices : [4, 4]),
        };
      };
      const [result] = await runPairedScenarios(input.options);
      expect(result?.measurementKind).toBe("mean-operation-work");
      expect(result?.referenceMs).toBe(8);
      expect(result?.candidateMs).toBe(expectedWork);
      for (const block of result!.blocks) {
        for (const measurement of block.measurements) {
          const slices = measurement.side === "candidate" ? candidateSlices : [4, 4];
          expect(measurement.samplesMs).toEqual(Array.from({ length: 13 }, () => slices).flat());
          expect(measurement.operationSampleCounts).toEqual(Array(13).fill(slices.length));
          expect(measurement.operationWorkMs).toEqual(Array(13).fill(measurement.meanMs));
        }
      }
    },
  );

  it("weights each operation equally when their interval counts differ", async () => {
    const input = fixture({
      create() {
        let operation = 0;
        let samples: number[] = [];
        return {
          run() {
            samples = operation++ % 2 === 0 ? [10] : [1, 1];
          },
          verify() {},
          dispose() {},
          measurementSamples: () => samples,
        };
      },
    });
    const [result] = await runPairedScenarios(input.options);
    expect(result?.referenceMs).toBe(6);
    expect(result?.candidateMs).toBe(6);
    for (const measurement of result!.blocks.flatMap((block) => block.measurements)) {
      expect(measurement.operationWorkMs).toHaveLength(17);
      expect(measurement.operationSampleCounts).toEqual(
        measurement.operationWorkMs.map((work) => (work === 10 ? 1 : 2)),
      );
      expect(measurement.samplesMs).toEqual(
        measurement.operationWorkMs.flatMap((work) => (work === 10 ? [10] : [1, 1])),
      );
    }
  });

  it("rejects operation sums that overflow finite numeric bounds", async () => {
    const input = fixture({
      create: () => ({
        run() {},
        verify() {},
        dispose() {},
        measurementSamples: () => [Number.MAX_VALUE, Number.MAX_VALUE],
      }),
    });
    await expect(runPairedScenarios(input.options)).rejects.toThrow("numeric bounds");
  });
});
