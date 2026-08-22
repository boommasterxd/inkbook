import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";
import type { MetadataGuardedFileRead } from "../saving/save-ports";
import { exactStringEqual } from "../saving/exact-string-equality";

import { migrationBackupPath } from "./file-naming";
import type { ValidatedVaultPath } from "./vault-path";

export interface MigrationBackupPort {
  createAndReadBack(
    path: string,
    content: string,
    maximumBytes: number,
  ): Promise<MetadataGuardedFileRead>;
  fileExists(path: string): boolean;
  readWithMetadataGuard(path: string, maximumBytes: number): Promise<MetadataGuardedFileRead>;
}

export async function ensureMigrationBackup(options: {
  readonly original: string;
  readonly path: ValidatedVaultPath;
  readonly port: MigrationBackupPort;
  readonly sourceVersion: number;
}): Promise<ValidatedVaultPath> {
  const backupPath = migrationBackupPath(options.path, options.sourceVersion);
  const read = options.port.fileExists(backupPath)
    ? await options.port.readWithMetadataGuard(backupPath, FILE_SCHEMA_LIMITS.totalInputBytes)
    : await options.port.createAndReadBack(
        backupPath,
        options.original,
        FILE_SCHEMA_LIMITS.totalInputBytes,
      );
  if (!exactStringEqual(read.content, options.original)) {
    throw new Error("migration-backup-content-mismatch");
  }
  return backupPath;
}
