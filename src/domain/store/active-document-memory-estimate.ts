import { connectionReferences } from "./connections";
import { elementMutationPayloadBytes } from "./mutation-payload";
import type { ElementRecord, StoreDelta } from "./types";

const ELEMENT_RUNTIME_OVERHEAD_BYTES = 768;
const SPATIAL_CELL_SIZE = 256;
const SPATIAL_MEMBERSHIP_BYTES = 64;
const MAXIMUM_ELEMENT_MEMBERSHIPS = 256;
const CONNECTION_REFERENCE_BYTES = 64;

export function estimateInitialStoreBytes(records: Iterable<ElementRecord>): number {
  let bytes = 0;
  for (const record of records) bytes += estimateRecordBytes(record);
  return bytes;
}

export function applyStoreDeltaBytes(current: number, delta: StoreDelta): number {
  let bytes = current;
  for (const change of delta.changes) {
    if (change.before !== null) bytes -= estimateRecordBytes(change.before);
    if (change.after !== null) bytes += estimateRecordBytes(change.after);
  }
  return Math.max(0, bytes);
}

function estimateRecordBytes(record: ElementRecord): number {
  return (
    ELEMENT_RUNTIME_OVERHEAD_BYTES +
    elementMutationPayloadBytes(record.element) +
    spatialMemberships(record) * SPATIAL_MEMBERSHIP_BYTES +
    connectionReferences(record.element).length * CONNECTION_REFERENCE_BYTES
  );
}

function spatialMemberships(record: ElementRecord): number {
  const { bounds } = record;
  const columns =
    Math.floor(bounds.maxX / SPATIAL_CELL_SIZE) - Math.floor(bounds.minX / SPATIAL_CELL_SIZE) + 1;
  const rows =
    Math.floor(bounds.maxY / SPATIAL_CELL_SIZE) - Math.floor(bounds.minY / SPATIAL_CELL_SIZE) + 1;
  return Math.min(MAXIMUM_ELEMENT_MEMBERSHIPS, columns * rows);
}
