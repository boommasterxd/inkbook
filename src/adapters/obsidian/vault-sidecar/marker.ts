import {
  MARKDOWN_SUFFIX,
  isAbortRequested,
  requireVaultFile,
  SIDECAR_SUFFIX,
  type NormalizeVaultPath,
  type VaultFileCapability,
  validateVaultRelativePath,
} from "./paths";

export const ANNOTATION_MARKER_KEY = "inkbook-annotations";
export const SIDECAR_LOCATOR_KEY = "inkbook-sidecar";
const MARKER_COMPARE_CONFLICT = new Error("Sidecar marker locator changed.");
const LEGACY_MARKER_CONFLICT = new Error("Legacy sidecar marker changed.");

export interface FrontMatterHostCapability {
  readonly normalizePath: NormalizeVaultPath;
  processFrontMatter(
    file: VaultFileCapability,
    callback: (frontmatter: Record<string, unknown>) => void,
  ): Promise<void>;
}

export type MarkerWriteResult =
  | { readonly kind: "acknowledged" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "conflict" }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "stale-acknowledgement" };

export function applySidecarMarker(
  frontmatter: Record<string, unknown>,
  sidecarPath: string,
): void {
  frontmatter[ANNOTATION_MARKER_KEY] = true;
  frontmatter[SIDECAR_LOCATOR_KEY] = sidecarPath;
}

export function removeSidecarMarker(
  frontmatter: Record<string, unknown>,
): void {
  delete frontmatter["inkbook-annotations"];
  delete frontmatter["inkbook-sidecar"];
}

export class SidecarMarkerWriter {
  private disposalGeneration = 0;
  private disposed = false;

  public constructor(private readonly host: FrontMatterHostCapability) {}

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposalGeneration += 1;
  }

  public set(
    noteFile: VaultFileCapability,
    sidecarPath: string,
    signal?: AbortSignal,
  ): Promise<MarkerWriteResult> {
    if (this.disposed) return Promise.resolve({ kind: "cancelled" });
    const locator = validateVaultRelativePath(
      sidecarPath,
      this.host.normalizePath,
      SIDECAR_SUFFIX,
    );
    return this.process(noteFile, signal, (frontmatter) => {
      applySidecarMarker(frontmatter, locator);
    });
  }

  public remove(
    noteFile: VaultFileCapability,
    signal?: AbortSignal,
  ): Promise<MarkerWriteResult> {
    if (this.disposed) return Promise.resolve({ kind: "cancelled" });
    return this.process(noteFile, signal, removeSidecarMarker);
  }

  public compareAndSetLocator(
    noteFile: VaultFileCapability,
    expectedSidecarPath: string,
    replacementSidecarPath: string,
    signal?: AbortSignal,
  ): Promise<MarkerWriteResult> {
    if (this.disposed) return Promise.resolve({ kind: "cancelled" });
    const expected = validateVaultRelativePath(
      expectedSidecarPath,
      this.host.normalizePath,
      SIDECAR_SUFFIX,
    );
    const replacement = validateVaultRelativePath(
      replacementSidecarPath,
      this.host.normalizePath,
      SIDECAR_SUFFIX,
    );
    return this.process(
      noteFile,
      signal,
      (frontmatter) => {
        if (
          frontmatter[ANNOTATION_MARKER_KEY] !== true ||
          frontmatter[SIDECAR_LOCATOR_KEY] !== expected
        ) {
          throw MARKER_COMPARE_CONFLICT;
        }
        applySidecarMarker(frontmatter, replacement);
      },
      MARKER_COMPARE_CONFLICT,
    );
  }

  public adoptLegacyLocator(
    noteFile: VaultFileCapability,
    sidecarPath: string,
    signal?: AbortSignal,
  ): Promise<MarkerWriteResult> {
    if (this.disposed) return Promise.resolve({ kind: "cancelled" });
    const locator = validateVaultRelativePath(
      sidecarPath,
      this.host.normalizePath,
      SIDECAR_SUFFIX,
    );
    return this.process(
      noteFile,
      signal,
      (frontmatter) => {
        if (
          frontmatter[ANNOTATION_MARKER_KEY] !== true ||
          frontmatter[SIDECAR_LOCATOR_KEY] !== undefined
        ) {
          throw LEGACY_MARKER_CONFLICT;
        }
        applySidecarMarker(frontmatter, locator);
      },
      LEGACY_MARKER_CONFLICT,
    );
  }

  private async process(
    noteFile: VaultFileCapability,
    signal: AbortSignal | undefined,
    callback: (frontmatter: Record<string, unknown>) => void,
    conflictError?: Error,
  ): Promise<MarkerWriteResult> {
    if (this.disposed) return { kind: "cancelled" };
    const disposalGeneration = this.disposalGeneration;
    if (isAbortRequested(signal)) return { kind: "cancelled" };
    const notePath = validateVaultRelativePath(
      noteFile.path,
      this.host.normalizePath,
      MARKDOWN_SUFFIX,
    );
    requireVaultFile(noteFile, notePath);
    try {
      await this.host.processFrontMatter(noteFile, callback);
      if (
        this.disposalGeneration !== disposalGeneration ||
        isAbortRequested(signal)
      ) {
        return { kind: "stale-acknowledgement" };
      }
      return { kind: "acknowledged" };
    } catch (error) {
      if (error === conflictError) return { kind: "conflict" };
      return { kind: "failed", error };
    }
  }
}
