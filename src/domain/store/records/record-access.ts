import type { ElementRecord } from "../types";

export function requireElementRecord(
  records: ReadonlyMap<string, ElementRecord>,
  id: string,
): ElementRecord {
  const record = records.get(id);
  if (record === undefined) throw new RangeError(`Unknown element ID: ${id}`);
  return record;
}
