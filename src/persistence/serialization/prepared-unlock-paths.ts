import { validatePathDataSteps } from "../documents/path-data-validator";
import type { InkElementV1 } from "../../domain/schema/public";
import type { SvgPathPart } from "../../domain/geometry/svg-path-part";

export interface PreparedUnlockPath {
  readonly id: string;
  readonly geometry: readonly SvgPathPart[];
}
export type PreparedPathObserver = (
  element: InkElementV1,
  geometry: readonly SvgPathPart[],
) => void;
const MAXIMUM_ENTRIES = 1024;
const MAXIMUM_BYTES = 4 * 1024 * 1024;

/** Includes UTF-16 string storage and bounded structured-clone entry overhead. */
function entryBytes(entry: PreparedUnlockPath): number {
  return (entry.id.length + entry.geometry[0]!.d.length) * 2 + 256;
}

export class PreparedUnlockPaths {
  readonly #paths: PreparedUnlockPath[] = [];
  #bytes = 2;
  #full = false;
  readonly #seen = new Set<string>();
  public readonly observe: PreparedPathObserver = (element, geometry) => {
    if (element.kind !== "stroke" || !element.style.pressureEnabled) return;
    if (this.#full || this.#seen.size >= MAXIMUM_ENTRIES || this.#seen.has(element.id)) return;
    this.#seen.add(element.id);
    if (geometry.length !== 1 || geometry[0]!.d.length > MAXIMUM_BYTES / 2) return;
    const entry = { id: element.id, geometry };
    const bytes = entryBytes(entry);
    if (this.#bytes + bytes > MAXIMUM_BYTES) {
      this.#full = true;
      return;
    }
    this.#paths.push(entry);
    this.#bytes += bytes;
  };
  public take(): readonly PreparedUnlockPath[] {
    this.#seen.clear();
    this.#bytes = 2;
    this.#full = false;
    return this.#paths.splice(0);
  }
}

/** Worker-produced path data remains bounded and allowlisted at the host boundary. */
export function isPreparedUnlockPaths(value: unknown): value is readonly PreparedUnlockPath[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_ENTRIES) return false;
  let bytes = 2;
  const ids = new Set<string>();
  for (const candidate of value as unknown[]) {
    if (!exactKeys(candidate, ["id", "geometry"])) return false;
    const entry = candidate as Partial<PreparedUnlockPath>;
    if (typeof entry.id !== "string" || entry.id.length > 64 || ids.has(entry.id)) return false;
    if (!Array.isArray(entry.geometry) || entry.geometry.length !== 1) return false;
    const part = entry.geometry[0] as Partial<SvgPathPart> | undefined;
    if (!exactKeys(part, ["d", "paint"])) return false;
    if (part!.paint !== "fill" || typeof part!.d !== "string" || part!.d.length > MAXIMUM_BYTES / 2)
      return false;
    bytes += entryBytes(entry as PreparedUnlockPath);
    if (bytes > MAXIMUM_BYTES) return false;
    ids.add(entry.id);
  }
  return true;
}

function exactKeys(value: unknown, expected: readonly string[]): boolean {
  if (value === null || typeof value !== "object") return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

/** Validate worker paths once, yielding between bounded command/byte slices. */
export async function validatePreparedUnlockGeometry(
  paths: readonly PreparedUnlockPath[],
  checkpoint: () => Promise<void>,
): Promise<boolean> {
  for (const entry of paths) {
    await checkpoint();
    const steps = validatePathDataSteps(entry.geometry[0]!.d);
    let step = steps.next();
    while (!step.done) {
      await checkpoint();
      step = steps.next();
    }
    if (step.value === null) return false;
  }
  return true;
}
