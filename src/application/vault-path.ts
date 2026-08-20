const MAX_VAULT_PATH_UTF16_UNITS_V1 = 4_096;
const WINDOWS_DRIVE_PATH = /^[a-z]:/iu;

export type VaultPathNormalizerV1 = (path: string) => string;

export interface VaultPathValidationOptionsV1 {
  readonly name?: string;
  readonly requiredSuffix?: string | null;
  readonly normalizePath?: VaultPathNormalizerV1;
  readonly isWithinVault?: (path: string) => boolean;
}

const IDENTITY_PATH_NORMALIZER: VaultPathNormalizerV1 = (path) => path;

export function normalizeVaultRelativePathV1(
  value: unknown,
  options: VaultPathValidationOptionsV1 = {},
): string {
  const name = options.name ?? "Vault path";
  const requiredSuffix = options.requiredSuffix ?? null;
  const path = validateRawPath(value, name, requiredSuffix);
  const normalizer = options.normalizePath ?? IDENTITY_PATH_NORMALIZER;
  let normalized: unknown;
  try {
    normalized = normalizer(path);
  } catch {
    throw invalidPath(name);
  }
  if (normalized !== path) throw invalidPath(name);
  validateRawPath(normalized, name, requiredSuffix);
  if (!isWithinVault(normalized, options.isWithinVault, name)) {
    throw invalidPath(name);
  }
  return normalized;
}

export function isValidVaultRelativePathV1(
  value: unknown,
  options: VaultPathValidationOptionsV1 = {},
): value is string {
  try {
    normalizeVaultRelativePathV1(value, options);
    return true;
  } catch {
    return false;
  }
}

export function isValidVaultRelativePrefixV1(value: unknown): value is string {
  return value === "" || isValidVaultRelativePathV1(value);
}

function validateRawPath(
  value: unknown,
  name: string,
  requiredSuffix: string | null,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_VAULT_PATH_UTF16_UNITS_V1
  ) {
    throw invalidPath(name);
  }
  const invalidSegment = value
    .split("/")
    .some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith("."),
    );
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    WINDOWS_DRIVE_PATH.test(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    invalidSegment ||
    (requiredSuffix !== null && !value.endsWith(requiredSuffix))
  ) {
    throw invalidPath(name);
  }
  return value;
}

function isWithinVault(
  path: string,
  predicate: VaultPathValidationOptionsV1["isWithinVault"],
  name: string,
): boolean {
  if (predicate === undefined) return true;
  try {
    return predicate(path);
  } catch {
    throw invalidPath(name);
  }
}

function invalidPath(name: string): TypeError {
  return new TypeError(
    `${name} is not a normalized visible Vault-relative path.`,
  );
}
