import { createStandardPersistenceFixture } from "../persistence/fixtures";
import type { ComparisonScenario } from "./contracts";
import { measureSlices, sliceSamples, type SliceResult } from "./persistence-slices";

type Wire = typeof import("../../../src/persistence/worker/runtime/wire-codec");
type Utf8 = typeof import("../../../src/persistence/scheduling/utf8-adoption");
type Trusted = typeof import("../../../src/persistence/scheduling/trusted-svg-output");
const file = "test/performance/persistence/wire-preparation-and-adoption.test.ts";

const TRANSFER_SLICE_MEASUREMENT_POLICY: Pick<
  ComparisonScenario,
  "execution" | "statistics" | "warmupOperations"
> = {
  execution: "async",
  statistics: [{ kind: "max", population: "samples" }],

  warmupOperations: 1,
};

export const PERSISTENCE_TRANSFER_SCENARIOS: readonly ComparisonScenario[] = [
  {
    id: "persistence-wire-pack-slices",
    modules: ["persistence/worker/runtime/wire-codec"],
    covers: [{ file, test: "packs the 10,000-stroke full request", ordinals: [1] }],
    ...TRANSFER_SLICE_MEASUREMENT_POLICY,
    create(implementation) {
      const wire = implementation.get<Wire>("persistence/worker/runtime/wire-codec");
      const snapshot = createStandardPersistenceFixture();
      return {
        run: () =>
          measureSlices((checkpoint) =>
            wire.encodeRuntimeRequestChunked(
              {
                baseModelRevision: null,
                exportGeneration: 1,
                modelRevision: snapshot.revision,
                sessionId: "comparison",
                snapshot,
                type: "export-full",
                workerEpoch: 1,
              },
              { checkpoint, signal: new AbortController().signal },
            ),
          ),
        measurementSamples: sliceSamples,
        verify(value) {
          const result = (
            value as SliceResult<Awaited<ReturnType<Wire["encodeRuntimeRequestChunked"]>>>
          ).value;
          if (result.value.type !== "export-full-wire" || result.transfer.length !== 10_000)
            throw new Error("Wire pack lost stroke buffers.");
        },
        dispose() {},
      };
    },
  },
  {
    id: "persistence-utf8-adoption-slices",
    modules: ["persistence/scheduling/utf8-adoption"],
    covers: [{ file, test: "adopts a maximum-size UTF-8 result", ordinals: [1] }],
    ...TRANSFER_SLICE_MEASUREMENT_POLICY,
    create(implementation) {
      const { adoptUtf8Output } = implementation.get<Utf8>("persistence/scheduling/utf8-adoption");
      const output = new Uint8Array(48 * 1024 * 1024).fill(97);
      return {
        run: () => measureSlices((checkpoint) => adoptUtf8Output(output, { checkpoint })),
        measurementSamples: sliceSamples,
        verify(value) {
          const result = (value as SliceResult<string>).value;
          if (
            result.length !== output.length ||
            result.charCodeAt(0) !== 97 ||
            result.charCodeAt(result.length - 1) !== 97
          )
            throw new Error("UTF-8 output adoption changed content.");
        },
        dispose() {},
      };
    },
  },
  {
    id: "persistence-clipboard-adoption-slices",
    modules: ["persistence/worker/runtime/wire-codec", "persistence/clipboard/constants"],
    covers: [{ file, test: "adopts one canonical clipboard representation", ordinals: [1] }],
    ...TRANSFER_SLICE_MEASUREMENT_POLICY,
    create(implementation) {
      const wire = implementation.get<Wire>("persistence/worker/runtime/wire-codec");
      const constants = implementation.get<
        typeof import("../../../src/persistence/clipboard/constants")
      >("persistence/clipboard/constants");
      const customText = "a".repeat(5 * 1024 * 1024 + 1);
      const encoded = wire.encodeRuntimeResult({
        identity: { operationId: 1, purpose: "clipboard", sessionId: "comparison", workerEpoch: 1 },
        result: {
          ok: true,
          value: {
            byteLength: customText.length,
            customText,
            plainText: `${constants.INKBOOK_CLIPBOARD_TEXT_PREFIX}${customText}`,
          },
        },
        type: "clipboard-encode-success",
      });
      return {
        run: () =>
          measureSlices((checkpoint) =>
            wire.decodeRuntimeResultChunked(encoded.value, {
              checkpoint,
              signal: new AbortController().signal,
            }),
          ),
        measurementSamples: sliceSamples,
        verify(value) {
          const result = (
            value as SliceResult<Awaited<ReturnType<Wire["decodeRuntimeResultChunked"]>>>
          ).value;
          if (
            result.type !== "clipboard-encode-success" ||
            !result.result.ok ||
            result.result.value.customText !== customText
          )
            throw new Error("Clipboard wire content mismatch.");
        },
        dispose() {},
      };
    },
  },
  {
    id: "persistence-safe-svg-slices",
    modules: ["persistence/scheduling/trusted-svg-output", "persistence/documents/svg-envelope"],
    covers: [
      {
        file: "test/performance/persistence/safe-svg-validation.test.ts",
        test: "validates a maximum-size, maximum-command path",
        ordinals: [1],
      },
    ],
    ...TRANSFER_SLICE_MEASUREMENT_POLICY,
    create(implementation) {
      const { inspectTrustedSvgOutput } = implementation.get<Trusted>(
        "persistence/scheduling/trusted-svg-output",
      );
      const { serializeSvgEnvelope } = implementation.get<
        typeof import("../../../src/persistence/documents/svg-envelope")
      >("persistence/documents/svg-envelope");
      const path = `M 0 0${" L 1 1".repeat(199_999)}`.padEnd(8 * 1024 * 1024, " ");
      const output = serializeSvgEnvelope(
        {
          elements: [],
          format: "inkbook",
          page: {
            activeBufferLines: 3,
            background: { type: "none" },
            innerWidth: 2000,
            lockedBufferLines: 1,
            margin: 24.3,
          },
          revision: 3,
          version: 1,
        },
        148.6,
        {
          background: [],
          content: [`<path d="${path}" fill="none" stroke="#112233FF"/>`],
          highlights: [],
        },
      );
      return {
        run: () =>
          measureSlices((checkpoint) =>
            inspectTrustedSvgOutput(output, undefined, {
              checkpoint,
              signal: new AbortController().signal,
            }),
          ),
        measurementSamples: sliceSamples,
        verify(value) {
          const result = value as SliceResult<
            Awaited<ReturnType<Trusted["inspectTrustedSvgOutput"]>>
          >;
          if (result.value.revision !== 3 || result.samples.length <= 700)
            throw new Error("Safe SVG fixture or slice coverage changed.");
        },
        dispose() {},
      };
    },
  },
];
