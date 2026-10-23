import { ensureMigrationBackup } from "../../../persistence/documents/migration-backup";
import { validateVaultPath } from "../../../persistence/documents/vault-path";
import type { VaultDocumentFilePort } from "./vault-document-loader";

/** Clears only the backed-up version, preserving a newer pending migration. */
export function createVaultMigrationPreserver(options: {
  readonly documentId: string;
  readonly files: VaultDocumentFilePort;
  readonly source: { version: number | undefined };
}): (content: string) => Promise<void> {
  return async (content) => {
    const sourceVersion = options.source.version;
    if (sourceVersion === undefined) return;
    const path = validateVaultPath(options.documentId);
    if (path === null) throw new Error("migration-backup-invalid-path");
    await ensureMigrationBackup({
      original: content,
      path,
      port: options.files,
      sourceVersion,
    });
    if (options.source.version === sourceVersion) options.source.version = undefined;
  };
}
