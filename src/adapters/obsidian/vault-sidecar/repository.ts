import {
  isAbortRequested,
  isVaultFileCapability,
  isVaultFolderCapability,
  parentVaultPath,
  requireVaultFile,
  SIDECAR_SUFFIX,
  type NormalizeVaultPath,
  type VaultAbstractFileCapability,
  type VaultFileCapability,
  validateVaultRelativePath,
} from "./paths";

const MEBIBYTE = 1_048_576;
export const SIDECAR_READ_LIMIT_BYTES = Number("16") * MEBIBYTE;
const RAW_TEXT_CONFLICT = new Error("Exact raw sidecar comparison failed.");
const ONE_BYTE_MAX_CODE_POINT = Number("127");
const TWO_BYTE_MAX_CODE_POINT = Number("2047");
const THREE_BYTE_MAX_CODE_POINT = Number("65535");
const TWO_UTF8_BYTES = Number("2");
const THREE_UTF8_BYTES = Number("3");
const FOUR_UTF8_BYTES = Number("4");

export interface SidecarVaultCapability {
  readonly normalizePath: NormalizeVaultPath;
  getFileByPath(path: string): VaultAbstractFileCapability | null;
  getFolderByPath(path: string): VaultAbstractFileCapability | null;
  cachedRead(file: VaultFileCapability): Promise<string>;
  create(path: string, contents: string): Promise<VaultFileCapability>;
  createFolder(path: string): Promise<void>;
  process(
    file: VaultFileCapability,
    callback: (currentText: string) => string,
  ): Promise<string>;
}

export interface PreparedSidecarWrite {
  readonly rawText: string;
  readonly utf8Bytes: number;
}

export type SidecarRawReadResult =
  | { readonly kind: "absent" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "invalid"; readonly error: unknown }
  | { readonly kind: "resource-limited" }
  | { readonly kind: "wrong-file-kind" }
  | {
      readonly admittedUtf8Bytes: number;
      readonly kind: "raw";
      readonly file: VaultFileCapability;
      readonly rawText: string;
    };

export type SidecarWriteResult =
  | { readonly kind: "acknowledged"; readonly rawText: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "collision" }
  | { readonly kind: "conflict" }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "stale-acknowledgement" }
  | { readonly kind: "wrong-file-kind" };

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point <= ONE_BYTE_MAX_CODE_POINT) bytes += 1;
    else if (point <= TWO_BYTE_MAX_CODE_POINT) bytes += TWO_UTF8_BYTES;
    else if (point <= THREE_BYTE_MAX_CODE_POINT) bytes += THREE_UTF8_BYTES;
    else bytes += FOUR_UTF8_BYTES;
    if (bytes > SIDECAR_READ_LIMIT_BYTES) return bytes;
  }
  return bytes;
}

export function isPreparedSidecarWriteValid(
  prepared: PreparedSidecarWrite,
): boolean {
  const measuredBytes = utf8ByteLength(prepared.rawText);
  return (
    measuredBytes <= SIDECAR_READ_LIMIT_BYTES &&
    measuredBytes === prepared.utf8Bytes
  );
}

export class VaultSidecarRepository {
  private disposalGeneration = 0;
  private disposed = false;

  public constructor(private readonly vault: SidecarVaultCapability) {}

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposalGeneration += 1;
  }

  public async readRaw(path: string): Promise<SidecarRawReadResult> {
    if (this.disposed) return { kind: "cancelled" };
    const disposalGeneration = this.disposalGeneration;
    const resolvedPath = validateVaultRelativePath(
      path,
      this.vault.normalizePath,
      SIDECAR_SUFFIX,
    );
    const abstractFile = this.vault.getFileByPath(resolvedPath);
    if (abstractFile === null) return { kind: "absent" };
    if (
      !isVaultFileCapability(abstractFile) ||
      abstractFile.path !== resolvedPath
    ) {
      return { kind: "wrong-file-kind" };
    }
    if (abstractFile.stat.size > SIDECAR_READ_LIMIT_BYTES) {
      return { kind: "resource-limited" };
    }
    let rawText: string;
    try {
      rawText = await this.vault.cachedRead(abstractFile);
    } catch (error) {
      return { kind: "invalid", error };
    }
    if (this.disposalGeneration !== disposalGeneration) {
      return { kind: "cancelled" };
    }
    if (rawText.length > SIDECAR_READ_LIMIT_BYTES) {
      return { kind: "resource-limited" };
    }
    return Object.freeze({
      admittedUtf8Bytes: abstractFile.stat.size,
      kind: "raw",
      file: abstractFile,
      rawText,
    });
  }

  public async createIfAbsent(
    path: string,
    prepared: PreparedSidecarWrite,
    signal?: AbortSignal,
  ): Promise<SidecarWriteResult> {
    if (this.disposed) return { kind: "cancelled" };
    if (!isPreparedSidecarWriteValid(prepared)) {
      return {
        kind: "failed",
        error: new RangeError(
          "Prepared sidecar bytes are invalid or over limit.",
        ),
      };
    }
    const disposalGeneration = this.disposalGeneration;
    if (isAbortRequested(signal)) return { kind: "cancelled" };
    const resolvedPath = validateVaultRelativePath(
      path,
      this.vault.normalizePath,
      SIDECAR_SUFFIX,
    );
    const folders = await this.ensureParentFolders(
      resolvedPath,
      signal,
      disposalGeneration,
    );
    if (folders !== null) return folders;
    if (this.vault.getFileByPath(resolvedPath) !== null) {
      return { kind: "collision" };
    }
    try {
      const created = await this.vault.create(resolvedPath, prepared.rawText);
      requireVaultFile(created, resolvedPath);
      if (
        this.disposalGeneration !== disposalGeneration ||
        isAbortRequested(signal)
      ) {
        return { kind: "stale-acknowledgement" };
      }
      return { kind: "acknowledged", rawText: prepared.rawText };
    } catch (error) {
      return this.vault.getFileByPath(resolvedPath) === null
        ? { kind: "failed", error }
        : { kind: "collision" };
    }
  }

  private async ensureParentFolders(
    filePath: string,
    signal: AbortSignal | undefined,
    disposalGeneration: number,
  ): Promise<SidecarWriteResult | null> {
    const parent = parentVaultPath(filePath);
    if (parent.length === 0) return null;
    const segments = parent.split("/");
    let current = "";
    for (const segment of segments) {
      current = current.length === 0 ? segment : `${current}/${segment}`;
      const existing = this.vault.getFolderByPath(current);
      if (isVaultFolderCapability(existing) && existing.path === current) {
        continue;
      }
      if (existing !== null || this.vault.getFileByPath(current) !== null) {
        return { kind: "wrong-file-kind" };
      }
      if (
        this.disposalGeneration !== disposalGeneration ||
        isAbortRequested(signal)
      ) {
        return { kind: "cancelled" };
      }
      try {
        await this.vault.createFolder(current);
      } catch (error) {
        const raced = this.vault.getFolderByPath(current);
        if (!isVaultFolderCapability(raced) || raced.path !== current) {
          return { kind: "failed", error };
        }
      }
    }
    return this.disposalGeneration !== disposalGeneration ||
      isAbortRequested(signal)
      ? { kind: "stale-acknowledgement" }
      : null;
  }

  public async compareAndProcess(
    file: VaultFileCapability,
    expectedRawText: string,
    prepared: PreparedSidecarWrite,
    signal?: AbortSignal,
  ): Promise<SidecarWriteResult> {
    if (this.disposed) return { kind: "cancelled" };
    if (!isPreparedSidecarWriteValid(prepared)) {
      return {
        kind: "failed",
        error: new RangeError(
          "Prepared sidecar bytes are invalid or over limit.",
        ),
      };
    }
    const disposalGeneration = this.disposalGeneration;
    if (isAbortRequested(signal)) return { kind: "cancelled" };
    const path = validateVaultRelativePath(
      file.path,
      this.vault.normalizePath,
      SIDECAR_SUFFIX,
    );
    const currentCapability = this.vault.getFileByPath(path);
    if (
      !isVaultFileCapability(currentCapability) ||
      currentCapability !== file
    ) {
      return { kind: "wrong-file-kind" };
    }
    try {
      const acknowledgedRawText = await this.vault.process(
        file,
        (currentText) => {
          if (currentText !== expectedRawText) throw RAW_TEXT_CONFLICT;
          return prepared.rawText;
        },
      );
      if (
        this.disposalGeneration !== disposalGeneration ||
        isAbortRequested(signal)
      ) {
        return { kind: "stale-acknowledgement" };
      }
      if (acknowledgedRawText !== prepared.rawText) {
        return {
          kind: "failed",
          error: new Error("Unexpected Vault acknowledgement."),
        };
      }
      return { kind: "acknowledged", rawText: acknowledgedRawText };
    } catch (error) {
      return error === RAW_TEXT_CONFLICT
        ? { kind: "conflict" }
        : { kind: "failed", error };
    }
  }
}
