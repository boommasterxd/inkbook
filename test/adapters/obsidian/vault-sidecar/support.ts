import {
  encodeInkbookSidecarV1,
  type InkbookSidecarV1,
  type SidecarWritableTierV1,
} from "../../../../src/application/persistence";
import type { SidecarVaultCapability } from "../../../../src/adapters/obsidian/vault-sidecar/repository";
import type { PreparedSidecarWrite } from "../../../../src/adapters/obsidian/vault-sidecar/repository";
import type { FrontMatterHostCapability } from "../../../../src/adapters/obsidian/vault-sidecar/marker";
import type { OrphanReviewScheduler } from "../../../../src/adapters/obsidian/vault-sidecar/events";
import type { SidecarRelocationVaultCapability } from "../../../../src/adapters/obsidian/vault-sidecar/relocation";
import type {
  VaultAbstractFileCapability,
  VaultFileCapability,
} from "../../../../src/adapters/obsidian/vault-sidecar/paths";

export interface FakeFile extends VaultFileCapability {
  readonly fileIdentity: symbol;
}

export interface FakeFolder {
  readonly path: string;
  readonly children: readonly unknown[];
}

export function fakeFile(path: string, size = 0): FakeFile {
  return Object.freeze({
    fileIdentity: Symbol(path),
    path,
    stat: Object.freeze({ size }),
  });
}

export function fakeFolder(path: string): FakeFolder {
  return Object.freeze({ children: Object.freeze([]), path });
}

export function preparedSidecarWrite(
  sidecar: InkbookSidecarV1,
  tier: SidecarWritableTierV1,
): PreparedSidecarWrite {
  const bytes = encodeInkbookSidecarV1(sidecar, tier);
  return Object.freeze({
    rawText: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    utf8Bytes: bytes.byteLength,
  });
}

export class FakeVault
  implements SidecarVaultCapability, SidecarRelocationVaultCapability
{
  public cachedReadCalls = 0;
  public createCalls = 0;
  public createFolderCalls = 0;
  public getFilesCalls = 0;
  public processCalls = 0;
  public renameCalls = 0;
  public processCallbackWasSynchronous = false;
  public readonly entries = new Map<string, VaultAbstractFileCapability>();
  public readonly texts = new Map<string, string>();
  public beforeCreate: ((path: string) => void) | undefined;
  public beforeProcess: ((path: string) => void) | undefined;
  public beforeRename:
    ((sourcePath: string, destinationPath: string) => void) | undefined;
  public cachedReadFailure: Error | undefined;
  public createBarrier: Promise<void> | undefined;
  public normalizeReplacement: ((path: string) => string) | undefined;
  public onRename:
    ((oldPath: string, destination: VaultFileCapability) => void) | undefined;

  private inProcessCallback = false;

  public addFile(path: string, text: string, reportedSize?: number): FakeFile {
    const file = fakeFile(
      path,
      reportedSize ?? new TextEncoder().encode(text).byteLength,
    );
    this.entries.set(path, file);
    this.texts.set(path, text);
    return file;
  }

  public addFolder(path: string): FakeFolder {
    const folder = fakeFolder(path);
    this.entries.set(path, folder);
    return folder;
  }

  public normalizePath = (path: string): string => {
    this.assertNoNestedIo();
    return this.normalizeReplacement?.(path) ?? path;
  };

  public getFileByPath(path: string): VaultAbstractFileCapability | null {
    this.assertNoNestedIo();
    return this.entries.get(path) ?? null;
  }

  public getFolderByPath(path: string): VaultAbstractFileCapability | null {
    this.assertNoNestedIo();
    const entry = this.entries.get(path);
    return entry !== undefined && "children" in entry ? entry : null;
  }

  public getFiles(): readonly VaultAbstractFileCapability[] {
    this.assertNoNestedIo();
    this.getFilesCalls += 1;
    return [...this.entries.values()];
  }

  public async cachedRead(file: VaultFileCapability): Promise<string> {
    this.assertNoNestedIo();
    this.cachedReadCalls += 1;
    if (this.cachedReadFailure !== undefined) throw this.cachedReadFailure;
    return this.texts.get(file.path) ?? "";
  }

  public async create(path: string, contents: string): Promise<FakeFile> {
    this.assertNoNestedIo();
    this.createCalls += 1;
    this.beforeCreate?.(path);
    await this.createBarrier;
    if (this.entries.has(path)) throw new Error("Path collision.");
    return this.addFile(path, contents);
  }

  public async createFolder(path: string): Promise<void> {
    this.assertNoNestedIo();
    this.createFolderCalls += 1;
    if (this.entries.has(path)) throw new Error("Path collision.");
    this.addFolder(path);
  }

  public async process(
    file: VaultFileCapability,
    callback: (currentText: string) => string,
  ): Promise<string> {
    this.assertNoNestedIo();
    this.processCalls += 1;
    this.beforeProcess?.(file.path);
    const current = this.texts.get(file.path);
    if (current === undefined) throw new Error("Missing file.");
    this.inProcessCallback = true;
    let replacement: string;
    try {
      replacement = callback(current);
      this.processCallbackWasSynchronous = typeof replacement === "string";
    } finally {
      this.inProcessCallback = false;
    }
    this.texts.set(file.path, replacement);
    return replacement;
  }

  public async rename(
    file: VaultFileCapability,
    destinationPath: string,
  ): Promise<void> {
    this.assertNoNestedIo();
    this.renameCalls += 1;
    const oldPath = file.path;
    this.beforeRename?.(oldPath, destinationPath);
    if (
      this.entries.get(oldPath) !== file ||
      this.entries.has(destinationPath)
    ) {
      throw new Error("Rename collision or stale source.");
    }
    const text = this.texts.get(oldPath) ?? "";
    this.entries.delete(oldPath);
    this.texts.delete(oldPath);
    const destination = this.addFile(destinationPath, text, file.stat.size);
    this.onRename?.(oldPath, destination);
  }

  private assertNoNestedIo(): void {
    if (this.inProcessCallback) throw new Error("Nested Vault I/O.");
  }
}

export class FakeFrontMatterHost implements FrontMatterHostCapability {
  public calls = 0;
  public rejectWith: unknown;
  public readonly frontmatter: Record<string, unknown>;

  public constructor(initial: Record<string, unknown>) {
    this.frontmatter = { ...initial };
  }

  public normalizePath(path: string): string {
    return path;
  }

  public async processFrontMatter(
    _file: VaultFileCapability,
    callback: (frontmatter: Record<string, unknown>) => void,
  ): Promise<void> {
    this.calls += 1;
    if (this.rejectWith !== undefined) {
      throw this.rejectWith instanceof Error
        ? this.rejectWith
        : new Error("Frontmatter processing failed.");
    }
    const result = callback(this.frontmatter);
    if (result !== undefined)
      throw new Error("Callback must return synchronously.");
  }
}

export class ControlledReviewScheduler implements OrphanReviewScheduler {
  public currentTime = 0;
  public yields = 0;
  public onYield: (() => void) | undefined;

  public now(): number {
    return this.currentTime;
  }

  public async yieldControl(): Promise<void> {
    this.yields += 1;
    this.onYield?.();
  }
}
