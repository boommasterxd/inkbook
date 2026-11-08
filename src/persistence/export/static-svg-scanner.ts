const SCAN_UNITS = 16 * 1024;

/** Scans prevalidated SVG in bounded pieces without retaining its metadata or path tokens. */
export function* findStaticSvgTokenSteps(
  input: string,
  token: string,
  start: number,
  exhausted: () => boolean,
): Generator<void, number> {
  for (let cursor = start; cursor < input.length; cursor += SCAN_UNITS) {
    const chunk = input.slice(cursor, cursor + SCAN_UNITS + token.length - 1);
    const offset = chunk.indexOf(token);
    if (exhausted()) yield;
    if (offset >= 0) return cursor + offset;
  }
  return -1;
}
