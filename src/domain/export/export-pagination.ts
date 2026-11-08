import { FILE_SCHEMA_LIMITS } from "../schema/public";
import {
  EXPORT_CUT_PREPARATION_CHUNK_SIZE,
  ExportCutIndex,
  type CutEvent,
} from "./export-cut-index";

export interface ExportInterval {
  readonly minY: number;
  readonly maxY: number;
}

export interface ExportCutOptions {
  readonly start: number;
  readonly limit: number;
  /** Minimum fragment height, measured from start. */
  readonly minimum: number;
  /** Preferred backward search distance; an earlier clear cut may exceed it. */
  readonly lookback: number;
  /** Keep painted antialiasing away from otherwise clear object boundaries. */
  readonly clearance?: number;
}

export type PreparedExportCuts = ExportCutIndex;

interface Endpoint {
  readonly y: number;
  readonly delta: -1 | 1;
}

/** Conservative bounds heuristic: minimizes crossed element intervals, not painted shapes. */
export function chooseExportCut(prepared: PreparedExportCuts, options: ExportCutOptions): number {
  const { start, limit, minimum, lookback, clearance = 0 } = options;
  if (
    ![start, limit, minimum, lookback, clearance].every(Number.isFinite) ||
    limit <= start ||
    minimum < 0 ||
    lookback < 0 ||
    clearance < 0
  ) {
    throw new RangeError("Export cut limits must be finite and make positive progress.");
  }
  const minimumY = start + minimum;
  if (minimumY >= limit) return limit;
  const lower = Math.max(minimumY, limit - lookback);
  const regular = prepared.choose(lower, limit, start, clearance);
  if (regular.crossings === 0 || lower === minimumY) return regular.y;
  const earlier = prepared.choose(minimumY, lower, start, clearance);
  return earlier.crossings === 0 ? earlier.y : regular.y;
}

/** Owns only numeric event data after preparation; callers drive central scheduler admission. */
export function* prepareExportCutsSteps(
  intervals: readonly ExportInterval[],
): Generator<void, PreparedExportCuts> {
  if (intervals.length > FILE_SCHEMA_LIMITS.elements) {
    throw new RangeError("Export interval count exceeds the document limit.");
  }
  const endpoints: Endpoint[] = [];
  for (let start = 0; start < intervals.length; start += EXPORT_CUT_PREPARATION_CHUNK_SIZE) {
    const end = Math.min(intervals.length, start + EXPORT_CUT_PREPARATION_CHUNK_SIZE);
    for (let index = start; index < end; index += 1) {
      const { minY, maxY } = intervals[index]!;
      if (!Number.isFinite(minY) || !Number.isFinite(maxY) || minY > maxY) {
        throw new RangeError("Export intervals require finite ordered bounds.");
      }
      if (minY < maxY) endpoints.push({ y: minY, delta: 1 }, { y: maxY, delta: -1 });
    }
    yield;
  }
  const sorted = yield* sortEndpoints(endpoints);
  const events = yield* collectEvents(sorted);
  return yield* ExportCutIndex.prepare(events);
}

function* sortEndpoints(endpoints: Endpoint[]): Generator<void, Endpoint[]> {
  let input = endpoints;
  for (let width = 1; width < endpoints.length; width *= 2) {
    const output: Endpoint[] = [];
    let operations = 0;
    for (let start = 0; start < endpoints.length; start += width * 2) {
      let left = start;
      let right = Math.min(start + width, endpoints.length);
      const middle = right;
      const end = Math.min(start + width * 2, endpoints.length);
      while (left < middle || right < end) {
        const takeLeft = right >= end || (left < middle && input[left]!.y <= input[right]!.y);
        output.push(input[takeLeft ? left++ : right++]!);
        if (++operations === EXPORT_CUT_PREPARATION_CHUNK_SIZE) {
          operations = 0;
          yield;
        }
      }
    }
    if (operations > 0) yield;
    input = output;
  }
  return input;
}

function* collectEvents(endpoints: readonly Endpoint[]): Generator<void, CutEvent[]> {
  const events: CutEvent[] = [];
  let active = 0;
  let cursor = 0;
  while (cursor < endpoints.length) {
    const y = endpoints[cursor]!.y;
    let starts = 0;
    let ends = 0;
    while (cursor < endpoints.length && endpoints[cursor]!.y === y) {
      if (endpoints[cursor]!.delta === 1) starts += 1;
      else ends += 1;
      cursor += 1;
      if (cursor % EXPORT_CUT_PREPARATION_CHUNK_SIZE === 0) yield;
    }
    const after = active - ends + starts;
    // A zero-width meeting of endpoints is not a clear horizontal strip of paper.
    const at = Math.min(active, after);
    active = after;
    events.push({ y, at, after: active });
  }
  if (cursor % EXPORT_CUT_PREPARATION_CHUNK_SIZE !== 0) yield;
  return events;
}
