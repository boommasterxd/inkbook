import { createClosedShapeGeometry } from "../../../domain/geometry/creation";
import {
  canonicalizeGeometryNumber,
  canonicalizeRotation,
  canonicalizeUnitIntervalNumber,
} from "../../../domain/schema/canonical";
import type { InkElementV1 } from "../../../domain/schema/types";
import { canonicalElement } from "../../serialization/metadata/canonical-snapshot";
import { array, invalid, record, text, type SourceRecord } from "./source-values";

/** The native writer owns field selection; conversion adds only the required precision rounding. */
export function* canonicalTargetSteps(
  element: InkElementV1,
  warnings: Set<string>,
): Generator<void, InkElementV1> {
  if (element.kind !== "stroke") {
    const target = roundHeader(element, warnings) as InkElementV1;
    if ("width" in target) {
      const geometry = createClosedShapeGeometry(
        { x: target.x, y: target.y },
        { x: target.x + target.width, y: target.y + target.height },
      );
      return canonicalElement({ ...target, pivot: geometry.pivot });
    }
    return canonicalElement(target);
  }
  const points = element.points;
  const header = roundHeader({ ...element, points: [] }, warnings) as typeof element;
  for (let index = 0; index < points.length; index += 3) {
    points[index] = rounded(points[index]!, false, warnings);
    points[index + 1] = rounded(points[index + 1]!, false, warnings);
    points[index + 2] = rounded(points[index + 2]!, true, warnings);
    yield;
  }
  const canonical = canonicalElement(header) as typeof element;
  return {
    ...canonical,
    points,
  };
}

function roundHeader(value: unknown, warnings: Set<string>, key = ""): unknown {
  if (typeof value === "number") {
    if (key === "createdAt") return value;
    if (key === "rotation") return canonicalizeRotation(value);
    return rounded(value, key.toLowerCase().endsWith("opacity"), warnings);
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, child]) => [name, roundHeader(child, warnings, name)]),
  );
}

function rounded(value: number, unit: boolean, warnings: Set<string>): number {
  const result = unit ? canonicalizeUnitIntervalNumber(value) : canonicalizeGeometryNumber(value);
  if (result !== value)
    warnings.add("Geometry, pressure and opacity were rounded to Inkbook's native precision.");
  return result;
}

export function* canvasOrderSteps(source: SourceRecord): Generator<void, SourceRecord[]> {
  const records: SourceRecord[] = [];
  const byId = new Map<string, SourceRecord>();
  for (const list of [
    array(source.strokes, "Canvas strokes"),
    array(source.shapes ?? [], "Canvas shapes"),
  ]) {
    for (const value of list) {
      const element = record(value, "Canvas element");
      const id = text(element.id, "Element id");
      if (byId.has(id)) invalid("Duplicate source element id.");
      byId.set(id, element);
      records.push(element);
      yield;
    }
  }
  if (source.elementOrder === undefined) return records;
  const order = array(source.elementOrder, "Element order");
  if (order.length !== records.length) invalid("Incomplete source element order.");
  const result: SourceRecord[] = [];
  for (const value of order) {
    const id = text(value, "Ordered element id");
    const element = byId.get(id);
    if (element === undefined) invalid("Unknown or duplicate ordered element id.");
    byId.delete(id);
    result.push(element);
    yield;
  }
  return result;
}

export function* sortSourceRecordsSteps(records: SourceRecord[]): Generator<void, SourceRecord[]> {
  let input = records;
  for (let width = 1; width < records.length; width *= 2) {
    const output: SourceRecord[] = [];
    for (let start = 0; start < records.length; start += width * 2) {
      let left = start;
      let right = Math.min(start + width, records.length);
      const middle = right;
      const end = Math.min(start + width * 2, records.length);
      while (left < middle || right < end) {
        const takeLeft =
          right >= end ||
          (left < middle && String(input[left]!.index) <= String(input[right]!.index));
        output.push(input[takeLeft ? left++ : right++]!);
        yield;
      }
    }
    input = output;
  }
  return input;
}
