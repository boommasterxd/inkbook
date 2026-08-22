import { describe, expect, it, vi } from "vitest";

import { ensureMigrationBackup } from "../../../../src/persistence/documents/migration-backup";
import { validateVaultPath } from "../../../../src/persistence/documents/vault-path";

function guardedRead(content: string) {
  return {
    content,
    identity: { ctime: 1, mtime: 1, path: "drawings/ink.backup-v0.svg", size: content.length },
    materialization: "host-full-read-not-bounded" as const,
    stabilityEvidence: "object-identity-and-stat-unchanged" as const,
  };
}

function existingBackup(content: string) {
  const createAndReadBack = vi.fn();
  const path = validateVaultPath("drawings/ink.svg");
  if (path === null) throw new Error("Expected a valid test path.");
  return {
    createAndReadBack,
    options: {
      original: "version-zero",
      path,
      port: {
        createAndReadBack,
        fileExists: () => true,
        readWithMetadataGuard: async () => guardedRead(content),
      },
      sourceVersion: 0,
    },
  };
}

describe("migration backup", () => {
  it("reuses an exact existing backup without creating another file", async () => {
    const { createAndReadBack, options } = existingBackup("version-zero");

    await expect(ensureMigrationBackup(options)).resolves.toBe("drawings/ink.backup-v0.svg");
    expect(createAndReadBack).not.toHaveBeenCalled();
  });

  it("refuses to replace a colliding backup with different content", async () => {
    const { createAndReadBack, options } = existingBackup("different-content");

    await expect(ensureMigrationBackup(options)).rejects.toThrow(
      "migration-backup-content-mismatch",
    );
    expect(createAndReadBack).not.toHaveBeenCalled();
  });
});
