type VaultFolderPathError =
  "empty" | "absolute" | "traversal" | "invalid-character" | "limit-exceeded";

const MAX_PATH_BYTES = 4096;
const MAX_PATH_SEGMENTS = 128;
const MAX_SEGMENT_BYTES = 255;

export type VaultFolderPathResult =
  | { readonly valid: true; readonly path: string }
  | { readonly valid: false; readonly error: VaultFolderPathError };

export function validateCustomVaultFolderPath(input: string): VaultFolderPathResult {
  if (!hasBoundedUtf8Length(input, MAX_PATH_BYTES)) return limitExceeded();
  if (input.includes("\0")) return { valid: false, error: "invalid-character" };
  const slashPath = input.trim();
  if (slashPath === "") {
    return { valid: false, error: "empty" };
  }
  if (slashPath.startsWith("/") || slashPath.startsWith("\\") || /^[A-Za-z]:/u.test(slashPath)) {
    return { valid: false, error: "absolute" };
  }
  const segments: string[] = [];
  let rawSegmentCount = 0;
  let start = 0;
  for (let index = 0; index <= slashPath.length; index += 1) {
    const separator =
      index === slashPath.length || slashPath[index] === "/" || slashPath[index] === "\\";
    if (!separator) continue;
    const segment = slashPath.slice(start, index);
    start = index + 1;
    rawSegmentCount += 1;
    if (rawSegmentCount > MAX_PATH_SEGMENTS) return limitExceeded();
    if (!hasBoundedUtf8Length(segment, MAX_SEGMENT_BYTES)) return limitExceeded();
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return { valid: false, error: "traversal" };
    segments.push(segment);
  }
  const normalized = segments.join("/");
  return normalized === "" ? { valid: false, error: "empty" } : { valid: true, path: normalized };
}

function hasBoundedUtf8Length(value: string, maximum: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length &&
      isLowSurrogate(value.charCodeAt(index + 1))
    ) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > maximum) return false;
  }
  return true;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function limitExceeded(): VaultFolderPathResult {
  return { valid: false, error: "limit-exceeded" };
}
