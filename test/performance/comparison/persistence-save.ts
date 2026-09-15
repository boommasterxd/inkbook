import { createStandardPersistenceFixture } from "../persistence/fixtures";
import type { ComparisonScenario } from "./contracts";
import { measureSlices, sliceSamples, type SliceResult } from "./persistence-slices";

type Serialization = typeof import("../../../src/persistence/serialization/public");
type Save = typeof import("../../../src/persistence/saving/save-existing");
const file = "test/performance/persistence/serialization-and-worker.test.ts";
export const PERSISTENCE_SAVE_SCENARIOS: readonly ComparisonScenario[] = [
  ...(["slices", "total"] as const).map((phase, index): ComparisonScenario => ({
    id: `persistence-integrity-${phase}`,
    modules: ["persistence/serialization/public"],
    covers: [{ file, test: "slices receiver-side integrity derivation", ordinals: [index + 1] }],
    execution: "async",
    statistics: [{ kind: "max", population: phase === "slices" ? "samples" : "operations" }],

    warmupOperations: 1,
    create(implementation) {
      const serialization = implementation.get<Serialization>("persistence/serialization/public");
      const snapshot = createStandardPersistenceFixture();
      const canonical = JSON.stringify(serialization.deriveDocumentIntegrityManifest(snapshot));
      return {
        run: () =>
          measureSlices((checkpoint) =>
            serialization.deriveDocumentIntegrityManifestAsync(snapshot, { checkpoint }),
          ),
        ...(phase === "slices" ? { measurementSamples: sliceSamples } : {}),
        verify(value) {
          if (JSON.stringify((value as SliceResult).value) !== canonical)
            throw new Error("Integrity manifest mismatch.");
        },
        dispose() {},
      };
    },
  })),
  {
    id: "persistence-exact-base-callback",
    modules: [
      "persistence/saving/save-existing",
      "persistence/serialization/public",
      "persistence/serialization/sha256",
    ],
    covers: [{ file, test: "keeps the synchronous exact-base callback", ordinals: [1] }],
    execution: "sync",
    statistics: [{ kind: "max", population: "operations" }],

    warmupOperations: 20,
    async create(implementation) {
      const save = implementation.get<Save>("persistence/saving/save-existing");
      const serialization = implementation.get<Serialization>("persistence/serialization/public");
      const { sha256Hex } = implementation.get<
        typeof import("../../../src/persistence/serialization/sha256")
      >("persistence/serialization/sha256");
      const serialized = serialization.serializeInkbookDocument(createStandardPersistenceFixture());
      if (!serialized.ok) throw new Error(serialized.error.code);
      const base = serialized.value.svg;
      let currentCopy = base;
      const next = base
        .replace('data-inkbook-revision="1"', 'data-inkbook-revision="2"')
        .replace('"revision":1', '"revision":2');
      const outputHash = sha256Hex(next);
      const size = new TextEncoder().encode(next).byteLength;
      let updateCallback: ((current: string) => string) | undefined;
      let releaseProcess: (() => void) | undefined;
      let readyCallback: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        readyCallback = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releaseProcess = resolve;
      });
      let persisted = base;
      const pending = save.saveExistingFile(
        { expectedBase: base, output: next, outputHash, path: "fixture.svg", revision: 2 },
        { currentRevision: () => 2 },
        {
          process: async (_path, update) => {
            updateCallback = update;
            readyCallback?.();
            await released;
            persisted = next;
            return persisted;
          },
          readWithMetadataGuard: async (path) => ({
            content: persisted,
            identity: { ctime: 1, mtime: 1, path, size },
            materialization: "host-full-read-not-bounded",
            stabilityEvidence: "object-identity-and-stat-unchanged",
          }),
        },
        {
          verify: async (content, revision, hash) =>
            content === next && revision === 2 && hash === outputHash,
        },
      );
      await Promise.race([
        ready,
        pending.then(() => {
          throw new Error("Save completed without exposing its update callback.");
        }),
      ]);
      const update = updateCallback;
      if (!update) throw new Error("Save update callback was not captured.");
      return {
        reset() {
          currentCopy = new TextDecoder().decode(new TextEncoder().encode(base));
        },
        run: () => update(currentCopy),
        verify(value) {
          if (value !== next) throw new Error("Exact-base callback changed its output.");
        },
        async dispose() {
          releaseProcess?.();
          const confirmed = await pending;
          if (confirmed.revision !== 2)
            throw new Error("Callback save read-back was not confirmed.");
        },
      };
    },
  },
];
