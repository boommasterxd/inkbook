const COMPARISON_CHUNK_CODE_UNITS = 256 * 1024;

export function exactStringEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  for (let offset = 0; offset < left.length; offset += COMPARISON_CHUNK_CODE_UNITS) {
    const end = Math.min(left.length, offset + COMPARISON_CHUNK_CODE_UNITS);
    if (left.slice(offset, end) !== right.slice(offset, end)) return false;
  }
  return true;
}
