const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/u;

export type ValidatedVaultPath = string & { readonly __vaultPath: unique symbol };

export function validateVaultPath(value: string): ValidatedVaultPath | null {
  if (value.length === 0 || value.includes("\0")) {
    return null;
  }

  const normalizedSeparators = value.replaceAll("\\", "/");
  if (
    normalizedSeparators.startsWith("/") ||
    WINDOWS_ABSOLUTE_PATH.test(value) ||
    normalizedSeparators.split("/").some((segment) => segment === "..")
  ) {
    return null;
  }

  const normalized = normalizedSeparators
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");

  return normalized.length === 0 ? null : (normalized as ValidatedVaultPath);
}

export function parentVaultPath(path: ValidatedVaultPath): ValidatedVaultPath | null {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? null : (path.slice(0, separator) as ValidatedVaultPath);
}

export function joinVaultPath(
  parent: ValidatedVaultPath | null,
  child: string,
): ValidatedVaultPath | null {
  return validateVaultPath(parent === null ? child : `${parent}/${child}`);
}
