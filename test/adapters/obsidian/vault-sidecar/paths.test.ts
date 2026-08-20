import { describe, expect, it } from "vitest";

import {
  deriveSidecarPath,
  isVaultFileCapability,
  isVaultFolderCapability,
  requireVaultFile,
  validateVaultRelativePath,
} from "../../../../src/adapters/obsidian/vault-sidecar/paths";
import { fakeFile, fakeFolder } from "./support";

const normalizePath = (path: string): string => path;

describe("Vault sidecar paths", () => {
  it("derives normalized adjacent and mirrored Vault-root paths", () => {
    expect(
      deriveSidecarPath("Courses/Math.md", { kind: "adjacent" }, normalizePath),
    ).toBe("Courses/Math.inkbook.json");
    expect(
      deriveSidecarPath(
        "Courses/Math.md",
        { kind: "vault-root", vaultRelativeRoot: "Annotations" },
        normalizePath,
      ),
    ).toBe("Annotations/Courses/Math.inkbook.json");
    expect(
      deriveSidecarPath(
        "Other/Math.md",
        { kind: "vault-root", vaultRelativeRoot: "Annotations" },
        normalizePath,
      ),
    ).toBe("Annotations/Other/Math.inkbook.json");
  });

  it.each([
    "",
    "/Notes/A.md",
    "C:/Notes/A.md",
    "Notes\\A.md",
    "Notes/../A.md",
    "Notes/./A.md",
    "Notes//A.md",
    ".obsidian/A.md",
    "Notes/.hidden/A.md",
    "Notes/A.md\0ignored",
  ])("rejects unsafe Vault path %j", (path) => {
    expect(() => validateVaultRelativePath(path, normalizePath)).toThrow();
  });

  it("requires the host normalization result to match exactly", () => {
    expect(() =>
      validateVaultRelativePath("Notes//A.md", (path) =>
        path.replace("//", "/"),
      ),
    ).toThrow();
    expect(() =>
      validateVaultRelativePath("Notes/A.md", () => "Other/A.md"),
    ).toThrow();
  });

  it("narrows file and folder capabilities without confusing either branch", () => {
    const file = fakeFile("Notes/A.md");
    const folder = fakeFolder("Notes");
    const confused = { ...file, children: [] };
    expect(isVaultFileCapability(file)).toBe(true);
    expect(isVaultFolderCapability(file)).toBe(false);
    expect(isVaultFolderCapability(folder)).toBe(true);
    expect(isVaultFileCapability(folder)).toBe(false);
    expect(isVaultFileCapability(confused)).toBe(false);
    expect(isVaultFolderCapability(confused)).toBe(false);
    expect(requireVaultFile(file, file.path)).toBe(file);
    expect(() => requireVaultFile(folder, folder.path)).toThrow();
    expect(() => requireVaultFile(file, "Notes/B.md")).toThrow();
  });
});
