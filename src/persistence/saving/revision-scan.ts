const ROOT_SCAN_BYTES = 4 * 1024;
const REVISION_PATTERN = /\bdata-inkbook-revision="(0|[1-9]\d*)"/u;

export function scanCanonicalRevisionPrefix(svg: string): number | null {
  const match = REVISION_PATTERN.exec(svg.slice(0, ROOT_SCAN_BYTES));
  if (match?.[1] === undefined) {
    return null;
  }
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) ? revision : null;
}
