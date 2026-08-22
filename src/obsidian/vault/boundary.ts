import { validateVaultPath, type ValidatedVaultPath } from "../../persistence/documents/vault-path";

export type VaultBoundaryErrorCode =
  | "file-not-found"
  | "file-too-large"
  | "folder-not-found"
  | "invalid-path"
  | "unexpected-host-result";

export class VaultBoundaryError extends Error {
  readonly code: VaultBoundaryErrorCode;

  constructor(code: VaultBoundaryErrorCode) {
    super(code);
    this.name = "VaultBoundaryError";
    this.code = code;
  }
}

export type PathNormalizer = (path: string) => string;

export function normalizeVaultPath(
  untrustedPath: string,
  normalizePath: PathNormalizer,
): ValidatedVaultPath {
  const prevalidated = validateVaultPath(untrustedPath);
  if (prevalidated === null) {
    throw new VaultBoundaryError("invalid-path");
  }

  const normalized = validateVaultPath(normalizePath(prevalidated));
  if (normalized === null) {
    throw new VaultBoundaryError("invalid-path");
  }
  return normalized;
}

export function normalizeSourcePath(
  untrustedPath: string,
  normalizePath: PathNormalizer,
): ValidatedVaultPath | "" {
  return untrustedPath === "" ? "" : normalizeVaultPath(untrustedPath, normalizePath);
}
