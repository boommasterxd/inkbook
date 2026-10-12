import {
  captureRuntimeElementHeader,
  copyStrokeSamplesToRuntimeSteps,
} from "../../domain/elements/runtime-element-copy";
import type { InkElementV1, InkSnapshotV1, PageV1 } from "../../domain/schema/public";
import { FILE_SCHEMA_LIMITS } from "../../domain/schema/constants";
import { fail } from "../../domain/schema/validation-internals";
import type { DocumentSerializationDelta } from "./incremental-document-serializer-types";

const SNAPSHOT_BODY_KEYS = new Set(["elements"]);

/** Capture external values into private candidates before schema validation may yield. */
export function* captureSnapshotInputSteps(
  snapshot: InkSnapshotV1,
): Generator<void, InkSnapshotV1> {
  const header = captureRuntimeElementHeader(snapshot, SNAPSHOT_BODY_KEYS);
  const elements = yield* captureListSteps(snapshot.elements);
  return { ...header, elements } as unknown as InkSnapshotV1;
}

export function* captureDeltaInputSteps<T extends DocumentSerializationDelta>(
  source: T,
): Generator<void, T> {
  const delta = { ...source };
  const page =
    delta.page === undefined
      ? undefined
      : (captureRuntimeElementHeader(delta.page) as unknown as PageV1);
  const removed = delta.removedIds;
  const highlight = delta.orderChanges?.highlight;
  const content = delta.orderChanges?.content;
  const derivations = delta.changedElementDerivations;
  const changed = delta.changedElements;
  const removedIds = removed === undefined ? undefined : yield* captureListSteps(removed);
  const capturedHighlight =
    highlight === undefined ? undefined : yield* captureListSteps(highlight);
  const capturedContent = content === undefined ? undefined : yield* captureListSteps(content);
  const changedElementDerivations =
    derivations === undefined
      ? undefined
      : yield* captureListSteps(derivations, captureRuntimeElementHeader);
  const changedElements = changed === undefined ? undefined : yield* captureListSteps(changed);
  return {
    ...delta,
    ...(page === undefined ? {} : { page }),
    ...(removedIds === undefined ? {} : { removedIds }),
    ...(delta.orderChanges === undefined
      ? {}
      : {
          orderChanges: {
            ...(capturedHighlight === undefined ? {} : { highlight: capturedHighlight }),
            ...(capturedContent === undefined ? {} : { content: capturedContent }),
          },
        }),
    ...(changedElementDerivations === undefined
      ? {}
      : {
          changedElementDerivations: changedElementDerivations as unknown as NonNullable<
            DocumentSerializationDelta["changedElementDerivations"]
          >,
        }),
    ...(changedElements === undefined ? {} : { changedElements }),
  };
}

/** Reuses the canonical domain header and sample-copy leaves, without a second validator. */
export function* copySerializationElementsSteps(
  elements: readonly InkElementV1[],
): Generator<void, InkElementV1[]> {
  const candidate: InkElementV1[] = [];
  const samples = { strokes: 0, strokePoints: 0 };
  for (const element of elements) {
    const header = captureRuntimeElementHeader(element);
    if (header.kind === "stroke") {
      if (element.kind !== "stroke") throw new TypeError("Stroke kind changed during capture.");
      assertStagedSampleCapacity(samples, element.points.length, `$.elements[${candidate.length}]`);
      const points = yield* copyStrokeSamplesToRuntimeSteps(element.points);
      candidate.push({ ...header, points } as unknown as InkElementV1);
    } else candidate.push(header as unknown as InkElementV1);
    if (candidate.length % 256 === 0) yield;
  }
  return candidate;
}

/** Apply existing document capacity before privately allocating the next sample buffer. */
export function assertStagedSampleCapacity(
  counts: { strokes: number; strokePoints: number },
  length: number,
  path: string,
): void {
  counts.strokes += 1;
  counts.strokePoints += length / 3;
  if (counts.strokes > FILE_SCHEMA_LIMITS.strokes)
    fail("stroke-limit-exceeded", path, "Stroke count exceeds the configured limit.");
  if (counts.strokePoints > FILE_SCHEMA_LIMITS.strokePoints)
    fail("stroke-point-limit-exceeded", path, "Stroke point count exceeds the configured limit.");
}

function* captureListSteps<T, U = T>(
  source: readonly T[],
  capture?: (value: T) => U,
): Generator<void, U[]> {
  assertSerializationList(source);
  const length = source.length;
  const candidate: U[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      throw new TypeError("Serialization lists must contain dense enumerable data values.");
    const value = source[index]!;
    candidate.push(capture === undefined ? (value as unknown as U) : capture(value));
    if ((index + 1) % 256 === 0) yield;
  }
  let keys = 0;
  // eslint-disable-next-line @typescript-eslint/no-for-in-array -- Bound hostile collection-key validation without allocating a complete key list.
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)
      throw new TypeError("Serialization lists must contain indexed values only.");
    if (++keys % 256 === 0) yield;
  }
  return candidate;
}

function assertSerializationList(source: unknown): void {
  if (
    !Array.isArray(source) ||
    Object.getPrototypeOf(source) !== Array.prototype ||
    Object.getOwnPropertySymbols(source).length > 0
  )
    throw new TypeError("Serialization lists must use plain arrays without symbols.");
  if (source.length > FILE_SCHEMA_LIMITS.elements)
    fail("element-limit-exceeded", "$.elements", "Element count exceeds the configured limit.");
}
