import {
  createClipboardLimitFixture,
  createMinimalPersistenceFixture,
  CLIPBOARD_ELEMENTS,
} from "../persistence/fixtures";
import type { ComparisonScenario } from "./contracts";

type Codec = typeof import("../../../src/persistence/clipboard/codec");
type Operations = typeof import("../../../src/persistence/clipboard/operations");
const file = "test/performance/persistence/clipboard.test.ts";
const test = "encodes and decodes the maximum deterministic clipboard fixture";

const CLIPBOARD_MEASUREMENT_POLICY: Pick<
  ComparisonScenario,
  "execution" | "statistics" | "warmupOperations"
> = {
  execution: "sync",
  statistics: [
    {
      kind: "p95",
      population: "operations",
      minimumSamples: 100,
      aggregation: "worst-window",
      windowSize: 20,
    },
  ],

  warmupOperations: 1,
};

export const PERSISTENCE_CLIPBOARD_SCENARIOS: readonly ComparisonScenario[] = [
  {
    id: "persistence-clipboard-copy",
    modules: ["persistence/clipboard/codec"],
    covers: [{ file, test, ordinals: [1] }],
    ...CLIPBOARD_MEASUREMENT_POLICY,
    create(implementation) {
      const codec = implementation.get<Codec>("persistence/clipboard/codec");
      const elements = createClipboardLimitFixture();
      const selected = new Set(elements.map(({ id }) => id));
      const canonical = codec.encodeRuntimeSelection(elements, selected);
      if (!canonical.ok) throw new Error(canonical.error.message);
      return {
        run: () => codec.encodeRuntimeSelection(elements, selected),
        verify(value) {
          const result = value as ReturnType<Codec["encodeRuntimeSelection"]>;
          if (
            !result.ok ||
            result.value.customText !== canonical.value.customText ||
            result.value.payload.elements.length !== CLIPBOARD_ELEMENTS
          )
            throw new Error("Clipboard copy lost canonical maximum-fixture content.");
        },
        dispose() {},
      };
    },
  },
  {
    id: "persistence-clipboard-paste",
    modules: ["persistence/clipboard/codec", "persistence/clipboard/operations"],
    covers: [{ file, test, ordinals: [2] }],
    ...CLIPBOARD_MEASUREMENT_POLICY,
    create(implementation) {
      const codec = implementation.get<Codec>("persistence/clipboard/codec");
      const operations = implementation.get<Operations>("persistence/clipboard/operations");
      const elements = createClipboardLimitFixture();
      const encoded = codec.encodeRuntimeSelection(elements, new Set(elements.map(({ id }) => id)));
      if (!encoded.ok) throw new Error(encoded.error.message);
      const page = createMinimalPersistenceFixture().page;
      return {
        run() {
          const decoded = codec.decodeCustomClipboardText(encoded.value.customText);
          if (!decoded.ok) throw new Error(decoded.error.message);
          let nextId = 0;
          return operations.planPaste({
            commandTimestamp: 1,
            createId: () => `10000000-0000-4000-8000-${(nextId++).toString(16).padStart(12, "0")}`,
            decoded: decoded.value,
            existingElements: [],
            page,
            target: { x: 1024, y: 512 },
          });
        },
        verify(value) {
          const result = value as ReturnType<Operations["planPaste"]>;
          if (!result.ok || result.value.elements.length !== CLIPBOARD_ELEMENTS)
            throw new Error("Clipboard paste lost maximum-fixture elements.");
        },
        dispose() {},
      };
    },
  },
];
