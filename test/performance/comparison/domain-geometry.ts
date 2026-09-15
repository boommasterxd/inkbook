import { assert } from "vitest";

import type { ElementRecord } from "../../../src/domain/store/types";
import {
  measureCanonicalRoundingFrame,
  measurePressureResizeFrame,
} from "../domain/geometry-frame-fixture";
import type { ComparisonScenario } from "./contracts";

const domainFile = (name: string) => `test/performance/domain/${name}.test.ts`;
const sample = (index: number) => ({
  x: index % 2 ? 200 : 0,
  y: index,
  pressure: index % 2,
  time: index,
});

export const DOMAIN_GEOMETRY_SCENARIOS: readonly ComparisonScenario[] = [
  {
    id: "domain-canonical-rounding",
    statistics: [{ kind: "p99", population: "samples", minimumSamples: 600 }],
    modules: ["domain/schema/canonical"],
    covers: [
      {
        file: domainFile("canonical-rounding-performance"),
        test: "rounds every coordinate",
        ordinals: [1],
      },
    ],
    execution: "sequence",
    sequenceLength: 600,

    warmupOperations: 0,
    create(implementation) {
      const { canonicalizeGeometryNumber } =
        implementation.get<typeof import("../../../src/domain/schema/canonical")>(
          "domain/schema/canonical",
        );
      const coordinates = Array.from({ length: 4096 * 2 }, (_, index) => index * 0.731 - 1999.781);
      let checksum = 0;
      let durations: number[] = [];
      return {
        *run() {
          checksum = 0;
          durations = [];
          for (let frame = 0; frame < 600; frame += 1) {
            const measured = measureCanonicalRoundingFrame(
              coordinates,
              frame,
              canonicalizeGeometryNumber,
              checksum,
            );
            checksum = measured.checksum;
            durations.push(measured.duration);
            yield;
          }
          return checksum;
        },
        measurementSamples() {
          return durations;
        },
        verify(result) {
          assert.equal(typeof result, "number");
          assert.ok(Number.isFinite(result));
          assert.equal(durations.length, 600);
        },
        dispose() {},
      };
    },
  },
  {
    id: "domain-overflow-membership",
    statistics: [{ kind: "total", population: "operations" }],
    modules: ["domain/store/record-factory"],
    covers: [
      {
        file: domainFile("overflow-capacity-performance"),
        test: "checks overlapping replacement and removal membership",
        ordinals: [1],
      },
    ],
    execution: "sync",

    warmupOperations: 16,
    create(implementation) {
      const { assertOverflowCapacity } = implementation.get<
        typeof import("../../../src/domain/store/record-factory")
      >("domain/store/record-factory");
      const records: ElementRecord[] = Array.from({ length: 20_000 }, (_, index) => ({
        bounds: { maxX: 1, maxY: 1, minX: 0, minY: 0 },
        element: { id: String(index) } as ElementRecord["element"],
        geometryVersion: 0,
        paintVersion: 0,
      }));
      return {
        run() {
          assertOverflowCapacity(0, records, [], records);
          return records.length;
        },
        verify(result) {
          assert.equal(result, 20_000);
        },
        dispose() {},
      };
    },
  },
  ...([false, true] as const).map((resize): ComparisonScenario => ({
    id: resize ? "domain-pressure-resize-curves" : "domain-pressure-live-tail",
    statistics: [{ kind: "p99", population: "samples", minimumSamples: resize ? 600 : 100 }],
    modules: ["domain/geometry/pressure-outline"],
    covers: [
      {
        file: domainFile("pressure-outline-performance"),
        test: resize ? "keeps 64 canonical resize curves" : "keeps maximum pressure transitions",
        ordinals: [1],
      },
    ],
    execution: resize ? "sequence" : "sync",
    ...(resize ? { sequenceLength: 600 } : {}),

    warmupOperations: resize ? 0 : 16,
    create(implementation) {
      const { buildPressureOutline } = implementation.get<
        typeof import("../../../src/domain/geometry/pressure-outline")
      >("domain/geometry/pressure-outline");
      const source = Array.from({ length: resize ? 70 : 16 }, (_, index) => sample(index));
      let durations: number[] = [];
      let outputs: ReturnType<typeof buildPressureOutline>[] = [];
      return {
        run: resize
          ? function* () {
              outputs = new Array<ReturnType<typeof buildPressureOutline>>(600);
              durations = [];
              for (let frame = 0; frame < 600; frame += 1) {
                const measured = measurePressureResizeFrame(source, frame, buildPressureOutline);
                outputs[frame] = measured.parts;
                durations.push(measured.duration);
                yield;
              }
              return outputs[outputs.length - 1];
            }
          : () => buildPressureOutline(source, 22),
        ...(resize ? { measurementSamples: () => durations } : {}),
        verify(result) {
          if (resize) {
            assert.equal(durations.length, 600);
            assert.ok(
              outputs.every(
                (parts) => parts.length === 1 && (parts[0]!.d.match(/[Qq]/g)?.length ?? 0) >= 128,
              ),
            );
          } else assert.equal((result as ReturnType<typeof buildPressureOutline>).length, 1);
        },
        dispose() {},
      };
    },
  })),
];
