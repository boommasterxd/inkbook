import { describe, expect, it } from "vitest";

import {
  createInkbookFilename,
  findAvailableInkbookPath,
  migrationBackupPath,
} from "../../../../src/persistence/documents/file-naming";
import {
  joinVaultPath,
  parentVaultPath,
  validateVaultPath,
} from "../../../../src/persistence/documents/vault-path";

describe("vault document paths", () => {
  it.each(["/absolute.svg", "C:\\absolute.svg", "../escape.svg", "folder/../escape.svg", "\0"])(
    "rejects unsafe path %s",
    (path) => {
      expect(validateVaultPath(path)).toBeNull();
    },
  );

  it("normalizes safe relative separators and segments", () => {
    const path = validateVaultPath("notes\\ink/./drawing.svg");
    expect(path).toBe("notes/ink/drawing.svg");
    expect(parentVaultPath(path!)).toBe("notes/ink");
    expect(joinVaultPath(parentVaultPath(path!), "next.svg")).toBe("notes/ink/next.svg");
  });

  it("creates the canonical timestamped lowercase-hex filename", () => {
    const filename = createInkbookFilename(new Date(2026, 7, 22, 9, 7, 5), {
      fill(bytes) {
        bytes.set([0, 15, 255]);
      },
    });
    expect(filename).toBe("inkbook-20260822-090705-000fff.svg");
  });

  it("retries collisions with a fresh suffix", async () => {
    let seed = 0;
    const result = await findAvailableInkbookPath(
      validateVaultPath("attachments"),
      new Date(2026, 0, 2, 3, 4, 5),
      {
        fill(bytes) {
          bytes.fill(seed);
          seed += 1;
        },
      },
      { exists: (path) => path.endsWith("000000.svg") },
    );
    expect(result).toBe("attachments/inkbook-20260102-030405-010101.svg");
  });

  it("derives bounded backup names", () => {
    const path = validateVaultPath("drawings/page.svg")!;
    expect(migrationBackupPath(path, 0)).toBe("drawings/page.backup-v0.svg");
  });
});
