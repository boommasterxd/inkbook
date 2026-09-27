import { describe, expect, it, vi } from "vitest";

import { FILE_SCHEMA_LIMITS } from "../../../../src/domain/schema/constants";
import { readExistingFileWithinLimit } from "../../../../src/persistence/saving/bounded-file-read";
import type { MetadataGuardedFileRead } from "../../../../src/persistence/saving/save-ports";
import { VerifiedMetadataGuardedFileRead } from "../../../../src/persistence/saving/verified-file-read";

function guardedRead(content: string, size: number): MetadataGuardedFileRead {
  return {
    content,
    identity: { ctime: 1, mtime: 1, path: "page.svg", size },
    materialization: "host-full-read-not-bounded",
    stabilityEvidence: "object-identity-and-stat-unchanged",
  };
}

describe("bounded existing-file read", () => {
  it("reuses an adapter-verified byte count without a second content scan", async () => {
    const content = "inkbook".repeat(1000);
    const read = VerifiedMetadataGuardedFileRead.create(
      content,
      guardedRead(content, content.length).identity,
      FILE_SCHEMA_LIMITS.totalInputBytes,
    );
    if (typeof read === "string") throw new Error("Expected a verified file read.");
    const charCodeAt = vi.spyOn(String.prototype, "charCodeAt");
    try {
      await expect(
        readExistingFileWithinLimit(
          {
            readWithMetadataGuard: async () => read,
            process: async () => content,
          },
          "page.svg",
        ),
      ).resolves.toBe(content);
      expect(charCodeAt).not.toHaveBeenCalled();
    } finally {
      charCodeAt.mockRestore();
    }
  });

  it("still measures an alternate port's unverified content", async () => {
    const content = "é".repeat(FILE_SCHEMA_LIMITS.totalInputBytes / 2 + 1);
    await expect(
      readExistingFileWithinLimit(
        {
          readWithMetadataGuard: async () => guardedRead(content, content.length),
          process: async () => content,
        },
        "page.svg",
      ),
    ).rejects.toThrow("exceeds the input byte limit after reading");
  });

  it("rejects forged or mutated byte proofs before they can skip the content check", () => {
    const content = "Inkbook";
    expect(
      VerifiedMetadataGuardedFileRead.create(
        content,
        guardedRead(content, content.length - 1).identity,
        FILE_SCHEMA_LIMITS.totalInputBytes,
      ),
    ).toBe("size-mismatch");
    const read = VerifiedMetadataGuardedFileRead.create(
      content,
      guardedRead(content, content.length).identity,
      FILE_SCHEMA_LIMITS.totalInputBytes,
    );
    if (typeof read === "string") throw new Error("Expected a verified file read.");
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.identity)).toBe(true);
    expect(VerifiedMetadataGuardedFileRead.isVerified({ ...read })).toBe(false);
  });
});
