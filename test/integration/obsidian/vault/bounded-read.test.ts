import { TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { FILE_SCHEMA_LIMITS } from "../../../../src/domain/schema/public";
import { readVaultFileWithinLimit } from "../../../../src/obsidian/vault/bounded-read";

const TestTFile = TFile as unknown as new (path: string, size: number) => TFile;

describe("bounded Obsidian vault reads", () => {
  it("returns content whose reported and actual sizes are within the file limit", async () => {
    const file = new TestTFile("drawing.svg", 3);
    const read = vi.fn(async () => "svg");

    await expect(readVaultFileWithinLimit({ read } as never, file)).resolves.toBe("svg");
    expect(read).toHaveBeenCalledWith(file);
  });

  it("rejects an oversized reported size before reading", async () => {
    const file = new TestTFile("drawing.svg", FILE_SCHEMA_LIMITS.totalInputBytes + 1);
    const read = vi.fn();

    await expect(readVaultFileWithinLimit({ read } as never, file)).rejects.toThrow(
      "exceeds the input byte limit",
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects oversized content returned after a stale size preflight", async () => {
    const file = new TestTFile("drawing.svg", 1);
    const read = vi.fn(async () => "a".repeat(FILE_SCHEMA_LIMITS.totalInputBytes + 1));

    await expect(readVaultFileWithinLimit({ read } as never, file)).rejects.toThrow(
      "after reading",
    );
  });
});
