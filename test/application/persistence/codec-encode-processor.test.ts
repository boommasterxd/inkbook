/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact slice and stress boundaries are the tested contract. */
import { describe, expect, it } from "vitest";

import { createResumableSidecarEncodeProcessorV1 } from "../../../src/application/persistence/codec-encode-processor";
import { CanonicalUtf8Processor } from "../../../src/application/persistence/codec-encode-processor-support";
import {
  encodeInkbookSidecarV1,
  prepareCanonicalSidecarV1,
  type PreparedCanonicalSidecarV1,
} from "../../../src/application/persistence/codec";
import {
  PERSISTENCE_CODEC_CHUNK_UNITS_V1,
  type PersistenceEncodedWorkResultV1,
} from "../../../src/application/persistence/codec-work";
import { PersistenceElementChunkCacheV1 } from "../../../src/application/persistence/element-chunk-cache";
import { canonicalizeJson } from "../../../src/domain/codecs";
import { createSceneRevision } from "../../../src/domain/model";
import { elementIdFor } from "../../domain/model/support";
import { completeSidecar } from "./support";

const STRESS_ELEMENT_COUNT = 10_000;
const MAX_PROCESS_STEPS = 1_000_000;

function runToCompletion(
  processor: ReturnType<typeof createResumableSidecarEncodeProcessorV1>,
): PersistenceEncodedWorkResultV1 {
  let steps = 0;
  while (!processor.processNext()) {
    steps += 1;
    if (steps > MAX_PROCESS_STEPS) throw new Error("Processor did not finish.");
  }
  return processor.complete();
}

function processorFor(
  prepared: PreparedCanonicalSidecarV1,
  cache = new PersistenceElementChunkCacheV1(),
  affectedElementIds = prepared.elements.map((element) => element.elementId),
): ReturnType<typeof createResumableSidecarEncodeProcessorV1> {
  return createResumableSidecarEncodeProcessorV1({
    prepared,
    writableTier: "desktop-tablet",
    noteKey:
      prepared.sidecarWithoutElements.noteIdentity.vaultRelativeMarkdownPath,
    affectedElementIds,
    elementCache: cache,
  });
}

function stressPrepared(): PreparedCanonicalSidecarV1 {
  const sidecar = completeSidecar();
  const template = sidecar.scene.elements[0];
  if (template === undefined) throw new Error("Missing element template.");
  const elements = Array.from({ length: STRESS_ELEMENT_COUNT }, (_, index) =>
    Object.freeze({ ...template, elementId: elementIdFor(index) }),
  );
  const objectOrder = Object.freeze(
    elements.map((element) => element.elementId),
  );
  const scene = Object.freeze({
    ...sidecar.scene,
    revision: createSceneRevision(1),
    elements: Object.freeze([]),
    objectOrder,
    groups: Object.freeze([]),
  });
  return Object.freeze({
    sidecarWithoutElements: Object.freeze({ ...sidecar, scene }),
    elements: Object.freeze(elements),
  });
}

describe("resumable canonical UTF-8 encoding", () => {
  it.each([
    PERSISTENCE_CODEC_CHUNK_UNITS_V1 - 1,
    PERSISTENCE_CODEC_CHUNK_UNITS_V1,
    PERSISTENCE_CODEC_CHUNK_UNITS_V1 + 1,
  ])("preserves canonical bytes at the %i-unit boundary", (units) => {
    const value = "x".repeat(units - 2);
    const processor = new CanonicalUtf8Processor(value);

    while (!processor.processNext()) {
      // Drive the same bounded phases used by the fallback scheduler.
    }

    expect(processor.complete()).toEqual(
      new TextEncoder().encode(canonicalizeJson(value)),
    );
  });

  it("preserves a surrogate pair split across canonical chunks", () => {
    const value = `${"x".repeat(PERSISTENCE_CODEC_CHUNK_UNITS_V1 - 2)}😀`;
    const processor = new CanonicalUtf8Processor(value);

    while (!processor.processNext()) {
      // The UTF-8 phase carries a trailing high surrogate into the next slice.
    }

    expect(processor.complete()).toEqual(
      new TextEncoder().encode(canonicalizeJson(value)),
    );
  });
});

describe("resumable sidecar encode after admission", () => {
  it("is byte-identical to the existing sidecar codec authority", () => {
    const sidecar = completeSidecar();
    const processor = processorFor(prepareCanonicalSidecarV1(sidecar));

    expect(() => processor.complete()).toThrow("incomplete");
    const result = runToCompletion(processor);

    expect(result.bytes).toEqual(
      encodeInkbookSidecarV1(sidecar, "desktop-tablet"),
    );
    expect(result.encodedElementCount).toBe(sidecar.scene.elements.length);
    expect(result.reusedElementCount).toBe(0);
    expect(processor.complete()).toBe(result);
  });

  it("does not publish cache state and releases retained work when disposed", () => {
    const prepared = prepareCanonicalSidecarV1(completeSidecar());
    const cache = new PersistenceElementChunkCacheV1();
    const processor = processorFor(prepared, cache);

    processor.processNext();
    processor.dispose();
    processor.dispose();

    expect(() => processor.processNext()).toThrow("disposed");
    expect(() => processor.complete()).toThrow("disposed");
    const element = prepared.elements[0];
    if (element === undefined) throw new Error("Missing test element.");
    expect(
      cache.findReusable("Notes/Example.md", element, false),
    ).toBeUndefined();
  });

  it("releases its active cache use after the cache is disposed", () => {
    const prepared = prepareCanonicalSidecarV1(completeSidecar());
    const cache = new PersistenceElementChunkCacheV1();
    const processor = processorFor(prepared, cache);

    cache.dispose();
    processor.dispose();
    processor.dispose();

    expect(cache.noteCount).toBe(0);
    expect(cache.ownedPayloadBytes).toBe(0);
    expect(cache.ownedCount).toBe(0);
  });

  it("re-encodes only one affected element in a 10,000-element warm save", () => {
    const prepared = stressPrepared();
    const cache = new PersistenceElementChunkCacheV1();
    const noteKey =
      prepared.sidecarWithoutElements.noteIdentity.vaultRelativeMarkdownPath;
    const seeded = cache.prepare(noteKey, prepared.elements, []);
    cache.commit(noteKey, seeded.chunks);
    const affected = prepared.elements[0]?.elementId;
    if (affected === undefined) throw new Error("Missing affected element.");

    const warm = runToCompletion(processorFor(prepared, cache, [affected]));

    expect(warm.elementCount).toBe(STRESS_ELEMENT_COUNT);
    expect(warm.encodedElementCount).toBe(1);
    expect(warm.reusedElementCount).toBe(STRESS_ELEMENT_COUNT - 1);
  });
});
