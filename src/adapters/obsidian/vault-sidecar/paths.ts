import type { SidecarStorageLayoutV1 } from "../../../application/persistence";
import { normalizeVaultRelativePathV1 } from "../../../application/vault-path";

export const SIDECAR_SUFFIX = ".inkbook.json";
export const MARKDOWN_SUFFIX = ".md";

export interface VaultFileCapability {
  readonly path: string;
  readonly stat: {
    readonly size: number;
  };
}

export interface VaultFolderCapability {
  readonly path: string;
  readonly children: readonly unknown[];
}

export type VaultAbstractFileCapability =
  VaultFileCapability | VaultFolderCapability;

export type NormalizeVaultPath = (path: string) => string;

export function isAbortRequested(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === "object";
}

function hasFileStat(value: Record<PropertyKey, unknown>): boolean {
  const stat = value.stat;
  return (
    isRecord(stat) &&
    typeof stat.size === "number" &&
    Number.isSafeInteger(stat.size) &&
    stat.size >= 0
  );
}

export function isVaultFileCapability(
  value: unknown,
): value is VaultFileCapability {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === "string" &&
    hasFileStat(value) &&
    !Array.isArray(value.children)
  );
}

export function isVaultFolderCapability(
  value: unknown,
): value is VaultFolderCapability {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === "string" &&
    Array.isArray(value.children) &&
    value.stat === undefined
  );
}

export function validateVaultRelativePath(
  path: string,
  normalizePath: NormalizeVaultPath,
  requiredSuffix?: string,
): string {
  return normalizeVaultRelativePathV1(path, {
    normalizePath,
    requiredSuffix: requiredSuffix ?? null,
  });
}

export function requireVaultFile(
  value: unknown,
  expectedPath: string,
): VaultFileCapability {
  if (!isVaultFileCapability(value) || value.path !== expectedPath) {
    throw new TypeError("The resolved Vault object is not the expected file.");
  }
  return value;
}

export function deriveSidecarPath(
  markdownPath: string,
  storage: SidecarStorageLayoutV1,
  normalizePath: NormalizeVaultPath,
): string {
  const notePath = validateVaultRelativePath(
    markdownPath,
    normalizePath,
    MARKDOWN_SUFFIX,
  );
  const noteStem = notePath.slice(0, -MARKDOWN_SUFFIX.length);
  if (storage.kind === "adjacent") {
    return validateVaultRelativePath(
      `${noteStem}${SIDECAR_SUFFIX}`,
      normalizePath,
      SIDECAR_SUFFIX,
    );
  }
  const root = validateVaultRelativePath(
    storage.vaultRelativeRoot,
    normalizePath,
  );
  return validateVaultRelativePath(
    `${root}/${noteStem}${SIDECAR_SUFFIX}`,
    normalizePath,
    SIDECAR_SUFFIX,
  );
}

export function parentVaultPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

export function isHiddenVaultPath(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}
