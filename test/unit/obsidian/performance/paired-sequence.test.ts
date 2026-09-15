import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ComparisonKernel,
  ComparisonScenario,
  ComparisonSide,
} from "../../../performance/comparison/contracts";
import { runPairedScenarios } from "../../../performance/comparison/paired-runner";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function sequenceFixture(override: Partial<ComparisonScenario> = {}) {
  const order: string[] = [];
  const kernels = new Map<ComparisonSide, ComparisonKernel>();
  const spies = new Map<
    ComparisonSide,
    {
      reset: ReturnType<typeof vi.fn>;
      verify: ReturnType<typeof vi.fn>;
      measurementSamples: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    }
  >();
  const lengths = { reference: 3, candidate: 3 };
  const implementation = (side: ComparisonSide) => ({ get: <T>() => side as T });
  const scenario: ComparisonScenario = {
    id: "sequence",
    modules: [],
    covers: [],
    execution: "sequence",
    sequenceLength: 3,

    warmupOperations: 0,
    create(impl) {
      const side = impl.get<ComparisonSide>("");
      const samples: number[] = [];
      const kernel = {
        reset: vi.fn(() => {
          order.push(`reset:${side}`);
        }),
        *run() {
          try {
            for (let step = 0; step < lengths[side]; step += 1) {
              order.push(`${side}:${step}`);
              const start = performance.now();
              samples.push(performance.now() - start);
              yield;
            }
            order.push(`done:${side}`);
            return side;
          } finally {
            order.push(`close:${side}`);
          }
        },
        verify: vi.fn((value: unknown) => {
          expect(value).toBe(side);
        }),
        measurementSamples: vi.fn(() => samples),
        dispose: vi.fn(),
      };
      kernels.set(side, kernel);
      spies.set(side, kernel);
      return kernel;
    },
    ...override,
  };
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock++);
  return {
    order,
    spies,
    kernels,
    lengths,
    scenario,
    options: {
      scenarios: [scenario],
      reference: implementation("reference"),
      candidate: implementation("candidate"),
      refreshRate: 240,
    },
  };
}

function configureKernels(
  scenario: ComparisonScenario,
  configure: (kernel: ComparisonKernel, side: ComparisonSide) => void,
): void {
  const create = scenario.create.bind(scenario);
  scenario.create = async (impl, hz) => {
    const kernel = await create(impl, hz);
    configure(kernel, impl.get<ComparisonSide>(""));
    return kernel;
  };
}

describe("paired stateful sequences", () => {
  it("collects preparation garbage after both resets and before measured steps", async () => {
    const input = sequenceFixture();
    const collect = vi.fn(() => input.order.push("collect"));
    vi.stubGlobal("gc", collect);
    const [result] = await runPairedScenarios(input.options);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(input.order.slice(0, 5)).toEqual([
      "reset:reference",
      "reset:candidate",
      "collect",
      "reference:0",
      "candidate:0",
    ]);
    expect(result).toMatchObject({ referenceMs: 3, candidateMs: 3 });
  });

  it("runs one persistent trajectory in exact AB/BA order and retains every real interval", async () => {
    const input = sequenceFixture();
    const [result] = await runPairedScenarios(input.options);
    expect(input.order).toEqual([
      "reset:reference",
      "reset:candidate",
      "reference:0",
      "candidate:0",
      "candidate:1",
      "reference:1",
      "reference:2",
      "candidate:2",
      "done:candidate",
      "close:candidate",
      "done:reference",
      "close:reference",
    ]);
    expect(result).toMatchObject({
      measurementKind: "paired-sequence-work",
      sequenceLength: 3,
      sequenceOrder: "alternating-ab-ba",
      referenceMs: 3,
      candidateMs: 3,
    });
    expect(result!.blocks).toHaveLength(1);
    expect(result!.blocks[0]!.measurements).toHaveLength(2);
    for (const measurement of result!.blocks[0]!.measurements) {
      expect(measurement.samplesMs).toEqual([1, 1, 1]);
      expect(measurement.operationWorkMs).toEqual([3]);
      expect(measurement.operationSampleCounts).toEqual([3]);
    }
    for (const [side, kernel] of input.spies) {
      expect(kernel.reset).toHaveBeenCalledOnce();
      expect(kernel.verify).toHaveBeenCalledExactlyOnceWith(side);
      expect(kernel.measurementSamples).toHaveBeenCalledExactlyOnceWith(side);
      expect(kernel.dispose).toHaveBeenCalledOnce();
    }
  });

  it.each([undefined, 0, -1, 1.5, Infinity, 1_000_001])(
    "rejects invalid sequence length %s before setup",
    async (sequenceLength) => {
      const input = sequenceFixture(sequenceLength === undefined ? {} : { sequenceLength });
      if (sequenceLength === undefined)
        delete (input.scenario as { sequenceLength?: number }).sequenceLength;
      await expect(runPairedScenarios(input.options)).rejects.toThrow("sequence length");
      expect(input.kernels.size).toBe(0);
    },
  );

  it.each([
    [2, 3, "different steps"],
    [2, 2, "before the required length"],
    [4, 4, "exceeded its required length"],
  ] as const)(
    "rejects reference/candidate lengths %s/%s and closes both generators",
    async (reference, candidate, message) => {
      const input = sequenceFixture();
      Object.assign(input.lengths, { reference, candidate });
      await expect(runPairedScenarios(input.options)).rejects.toThrow(message);
      for (const [side, kernel] of input.spies) {
        expect(input.order).toContain(`close:${side}`);
        expect(kernel.verify).not.toHaveBeenCalled();
        expect(kernel.dispose).toHaveBeenCalledOnce();
      }
    },
  );
});

describe("paired asynchronous and malformed sequences", () => {
  it("awaits asynchronous steps without overlapping paired work", async () => {
    const input = sequenceFixture({ execution: "async-sequence" });
    let active = false;
    configureKernels(input.scenario, (kernel) => {
      const run = kernel.run.bind(kernel);
      kernel.run = async function* () {
        const iterator = run() as Generator<void, unknown, void>;
        while (true) {
          expect(active).toBe(false);
          active = true;
          await Promise.resolve();
          const result = iterator.next();
          active = false;
          if (result.done) return result.value;
          yield;
        }
      };
    });
    const [result] = await runPairedScenarios(input.options);
    expect(result!.referenceMs).toBe(3);
    expect(input.order.filter((entry) => /:\d$/.test(entry))).toEqual([
      "reference:0",
      "candidate:0",
      "candidate:1",
      "reference:1",
      "reference:2",
      "candidate:2",
    ]);
  });

  it.each([[], [-1], [NaN], [Infinity]].map((samples) => ({ samples })))(
    "rejects invalid final real samples %j",
    async ({ samples }) => {
      const input = sequenceFixture();
      configureKernels(input.scenario, (kernel) => {
        kernel.measurementSamples = () => samples;
      });
      await expect(runPairedScenarios(input.options)).rejects.toThrow("invalid wall-clock");
      for (const kernel of input.spies.values()) expect(kernel.dispose).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [() => ({}), "must return an iterator"],
    [() => ({ next: () => ({ value: undefined }) }), "invalid iterator step"],
    [() => ({ next: () => ({ done: false, value: 1 }) }), "must not carry a value"],
    [() => ({ next: () => Promise.reject(new Error("async")) }), "asynchronous step"],
  ])("rejects malformed sequence producers", async (run, message) => {
    const input = sequenceFixture();
    configureKernels(input.scenario, (kernel) => {
      kernel.run = run;
    });
    await expect(runPairedScenarios(input.options)).rejects.toThrow(message);
    for (const kernel of input.spies.values()) expect(kernel.dispose).toHaveBeenCalledOnce();
  });
});

describe("paired sequence failure lifecycle", () => {
  it.each(["reset", "verify", "measurementSamples", "dispose"] as const)(
    "disposes both kernels when candidate %s fails",
    async (phase) => {
      const input = sequenceFixture();
      configureKernels(input.scenario, (kernel, side) => {
        if (side === "candidate") {
          kernel[phase] = () => {
            throw new Error(`failed:${phase}`);
          };
        }
      });
      await expect(runPairedScenarios(input.options)).rejects.toThrow(`failed:${phase}`);
      expect(input.spies.get("reference")!.dispose).toHaveBeenCalledOnce();
      if (phase !== "dispose") expect(input.spies.get("candidate")!.dispose).toHaveBeenCalledOnce();
    },
  );

  it("still closes reference and disposes both when candidate iterator cleanup fails", async () => {
    const input = sequenceFixture();
    input.lengths.candidate = 4;
    configureKernels(input.scenario, (kernel, side) => {
      if (side === "candidate") {
        const run = kernel.run.bind(kernel);
        kernel.run = () => {
          const iterator = run() as Generator<void, unknown, void>;
          iterator.return = () => {
            throw new Error("cleanup failed");
          };
          return iterator;
        };
      }
    });
    await expect(runPairedScenarios(input.options)).rejects.toThrow("cleanup failed");
    expect(input.order).toContain("close:reference");
    for (const spies of input.spies.values()) expect(spies.dispose).toHaveBeenCalledOnce();
  });

  it("does not insert microtasks between synchronous trajectory steps", async () => {
    const input = sequenceFixture();
    let interrupted = false;
    configureKernels(input.scenario, (kernel) => {
      const run = kernel.run.bind(kernel);
      kernel.run = function* () {
        queueMicrotask(() => {
          interrupted = true;
        });
        const iterator = run() as Generator<void, unknown, void>;
        while (true) {
          expect(interrupted).toBe(false);
          const result = iterator.next();
          if (result.done) return result.value;
          yield;
        }
      };
    });
    await runPairedScenarios(input.options);
    expect(interrupted).toBe(true);
  });
});

describe("fresh-process sequence counterbalancing", () => {
  it.each([0, 1, 2])(
    "counterbalances reset and first-step order in round %s",
    async (roundIndex) => {
      const input = sequenceFixture();
      const [result] = await runPairedScenarios({ ...input.options, roundIndex });
      const [first, second] =
        roundIndex === 1 ? ["candidate", "reference"] : ["reference", "candidate"];
      expect(input.order.slice(0, 8)).toEqual([
        `reset:${first}`,
        `reset:${second}`,
        `${first}:0`,
        `${second}:0`,
        `${second}:1`,
        `${first}:1`,
        `${first}:2`,
        `${second}:2`,
      ]);
      expect(result!.sequenceOrder).toBe(
        roundIndex === 1 ? "alternating-ba-ab" : "alternating-ab-ba",
      );
      expect(result!.referenceMs).toBe(3);
      expect(result!.candidateMs).toBe(3);
      for (const spies of input.spies.values()) {
        expect(spies.reset).toHaveBeenCalledOnce();
        expect(spies.dispose).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([-1, 3, 0.5, NaN, Infinity])(
    "rejects invalid round %s before setup",
    async (roundIndex) => {
      const input = sequenceFixture();
      await expect(runPairedScenarios({ ...input.options, roundIndex })).rejects.toThrow(
        "round index",
      );
      expect(input.kernels.size).toBe(0);
    },
  );
});
