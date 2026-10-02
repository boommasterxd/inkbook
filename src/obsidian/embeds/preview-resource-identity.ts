import type { TFile, Vault } from "obsidian";
import type { PreviewContentIdentity } from "./safe-preview-svg";

export function previewSourceIdentity(source: string): PreviewContentIdentity | undefined {
  try {
    const value = new URL(source).searchParams.get("inkbook-revision");
    const match = /^(\d+)-([a-f0-9]{64})$/u.exec(value ?? "");
    const revision = Number(match?.[1]);
    return match !== null && Number.isSafeInteger(revision)
      ? { revision, outputHash: match[2]! }
      : undefined;
  } catch {
    return undefined;
  }
}

export function matchesPreviewResource(vault: Vault, file: TFile, source: string): boolean {
  try {
    const expected = new URL(vault.getResourcePath(file));
    const actual = new URL(source);
    expected.search = "";
    expected.hash = "";
    actual.search = "";
    actual.hash = "";
    return actual.href === expected.href;
  } catch {
    return false;
  }
}
