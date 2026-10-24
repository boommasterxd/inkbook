import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";

const COMPARISON_CHUNK_CODE_UNITS = 256 * 1024;

export function exactStringEqual(left: string, right: string): boolean {
  return left === right;
}

export async function exactStringEqualScheduled(
  left: string,
  right: string,
  workScheduler: WorkScheduler,
): Promise<boolean> {
  if (left.length !== right.length) return false;
  for (let offset = 0; offset < left.length; offset += COMPARISON_CHUNK_CODE_UNITS) {
    const admission = workScheduler.checkpoint();
    if (admission !== undefined) await admission;
    if (!equalChunk(left, right, offset)) return false;
  }
  return true;
}

function equalChunk(left: string, right: string, offset: number): boolean {
  const end = Math.min(left.length, offset + COMPARISON_CHUNK_CODE_UNITS);
  return left.slice(offset, end) === right.slice(offset, end);
}
