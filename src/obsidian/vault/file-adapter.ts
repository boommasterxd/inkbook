import { Component, type TAbstractFile, type TFile, type TFolder, type Vault } from "obsidian";

import type {
  ExistingFilePort,
  FileReadIdentity,
  MetadataGuardedFileRead,
  NewFilePort,
} from "../../persistence/saving/save-ports";
import { FILE_SCHEMA_LIMITS } from "../../domain/schema/constants";
import { VerifiedMetadataGuardedFileRead } from "../../persistence/saving/verified-file-read";
import { MetadataGuardedFileReadCandidate } from "../../persistence/saving/metadata-guarded-file-read";
import { normalizeVaultPath, VaultBoundaryError, type PathNormalizer } from "./boundary";

type HostConstructor<T> = abstract new (...arguments_: never[]) => T;

export interface ObsidianFileClasses {
  readonly file: HostConstructor<TFile>;
  readonly folder: HostConstructor<TFolder>;
}

export interface UnlockFile {
  readonly bytes: ArrayBuffer;
  readonly path: string;
  readonly size: number;
}

export interface CreatedVaultFile {
  readonly file: TFile;
  readonly isCurrent: () => boolean;
}

export interface CreatedVaultFileRead extends CreatedVaultFile {
  readonly readBack: MetadataGuardedFileRead;
}

export interface TrackedCreatedVaultFile extends CreatedVaultFile {
  release(): void;
}

export class ObsidianVaultFileAdapter implements ExistingFilePort, NewFilePort {
  readonly #classes: ObsidianFileClasses;
  readonly #normalizePath: PathNormalizer;
  readonly #operationsByPath = new Map<string, Promise<void>>();
  readonly #vault: Vault;
  readonly #modifications = new WeakMap<TFile, number>();

  constructor(vault: Vault, classes: ObsidianFileClasses, normalizePath: PathNormalizer) {
    this.#vault = vault;
    this.#classes = classes;
    this.#normalizePath = normalizePath;
  }

  resolveFile(untrustedPath: string): TFile {
    const path = normalizeVaultPath(untrustedPath, this.#normalizePath);
    const file = this.#vault.getFileByPath(path);
    if (!(file instanceof this.#classes.file)) {
      throw new VaultBoundaryError("file-not-found");
    }
    return file;
  }

  noteModification(path: string): void {
    const file = this.#vault.getFileByPath(path);
    if (file instanceof this.#classes.file) {
      this.#modifications.set(file, (this.#modifications.get(file) ?? 0) + 1);
    }
  }

  resolveFolder(untrustedPath: string | null): TFolder {
    const folder =
      untrustedPath === null
        ? this.#vault.getRoot()
        : this.#vault.getFolderByPath(normalizeVaultPath(untrustedPath, this.#normalizePath));
    if (!(folder instanceof this.#classes.folder)) {
      throw new VaultBoundaryError("folder-not-found");
    }
    return folder;
  }

  async read(path: string): Promise<string> {
    return (await this.readWithMetadataGuard(path, FILE_SCHEMA_LIMITS.totalInputBytes)).content;
  }

  async size(path: string): Promise<number> {
    return snapshotIdentity(this.resolveFile(path)).size;
  }

  async cachedRead(path: string): Promise<string> {
    return this.#readTextWithMetadataGuard(path, FILE_SCHEMA_LIMITS.totalInputBytes, (file) =>
      this.#vault.cachedRead(file),
    ).then((read) => read.content);
  }

  async readBinaryForUnlock(path: string, maximumBytes: number): Promise<UnlockFile> {
    return this.#readWithMetadataGuard(path, maximumBytes, async (normalizedPath, file, before) => {
      const bytes = await this.#vault.readBinary(file);
      const after = this.#verifyStableRead(normalizedPath, file, before);
      assertSizeWithinLimit(bytes.byteLength, maximumBytes);
      if (bytes.byteLength !== before.size || bytes.byteLength !== after.size) {
        throw new VaultBoundaryError("unexpected-host-result");
      }
      return { bytes, path: normalizedPath, size: bytes.byteLength };
    });
  }

  async readWithMetadataGuard(
    path: string,
    maximumBytes: number,
  ): Promise<MetadataGuardedFileRead> {
    return this.#readTextWithMetadataGuard(path, maximumBytes, (file) => this.#vault.read(file));
  }

  async readForVerification(path: string, maximumBytes: number): Promise<MetadataGuardedFileRead> {
    return this.#readWithMetadataGuard(path, maximumBytes, (normalizedPath) =>
      this.#readText(normalizedPath, maximumBytes, (file) => this.#vault.read(file), true),
    );
  }

  #readWithMetadataGuard<Result>(
    path: string,
    maximumBytes: number,
    operation: (normalizedPath: string, file: TFile, before: FileReadIdentity) => Promise<Result>,
  ): Promise<Result> {
    assertMaximumBytes(maximumBytes);
    const normalizedPath = normalizeVaultPath(path, this.#normalizePath);
    return this.#serialize(normalizedPath, async () => {
      const file = this.resolveFile(normalizedPath);
      const before = snapshotIdentity(file);
      assertSizeWithinLimit(before.size, maximumBytes);
      return operation(normalizedPath, file, before);
    });
  }

  async process(path: string, update: (current: string) => string): Promise<string> {
    const normalizedPath = normalizeVaultPath(path, this.#normalizePath);
    return this.#serialize(normalizedPath, () =>
      this.#vault.process(this.resolveFile(normalizedPath), update),
    );
  }

  async create(path: string, content: string): Promise<void> {
    const normalizedPath = normalizeVaultPath(path, this.#normalizePath);
    await this.#serialize(normalizedPath, () => this.#create(normalizedPath, content));
  }

  async createAndReadBack(
    path: string,
    content: string,
    maximumBytes: number,
  ): Promise<MetadataGuardedFileRead> {
    return this.#createAndReadBack(path, content, maximumBytes, false).then(
      (created) => created.readBack,
    );
  }

  async createOwnedAndReadBack(
    path: string,
    content: string,
    maximumBytes: number,
    onCreated?: (created: TrackedCreatedVaultFile) => void,
  ): Promise<CreatedVaultFileRead> {
    if (onCreated === undefined) return this.#createAndReadBack(path, content, maximumBytes, false);
    const normalizedPath = normalizeVaultPath(path, this.#normalizePath);
    const owner = new Component();
    let ownedFile: TFile | undefined;
    let changed = false;
    let transferred = false;
    let released = false;
    const release = () => {
      released = true;
      owner.unload();
    };
    const noteChange = (file: TAbstractFile, oldPath?: string) => {
      if (file === ownedFile || file.path === normalizedPath || oldPath === normalizedPath) {
        changed = true;
      }
    };
    owner.load();
    try {
      owner.registerEvent(this.#vault.on("modify", noteChange));
      owner.registerEvent(this.#vault.on("rename", noteChange));
      owner.registerEvent(this.#vault.on("delete", noteChange));
      return await this.#createAndReadBack(path, content, maximumBytes, false, (created) => {
        ownedFile = created.file;
        // The command owns this event lifetime until its insertion or rollback settles.
        onCreated({
          ...created,
          isCurrent: () => !released && !changed && created.isCurrent(),
          release,
        });
        transferred = true;
      });
    } finally {
      if (!transferred) release();
    }
  }

  async createAndReadBackForVerification(
    path: string,
    content: string,
    maximumBytes: number,
  ): Promise<MetadataGuardedFileRead> {
    return this.#createAndReadBack(path, content, maximumBytes, true).then(
      (created) => created.readBack,
    );
  }

  #createAndReadBack(
    path: string,
    content: string,
    maximumBytes: number,
    deferByteVerification: boolean,
    onCreated?: (created: CreatedVaultFile) => void,
  ): Promise<CreatedVaultFileRead> {
    assertMaximumBytes(maximumBytes);
    const normalizedPath = normalizeVaultPath(path, this.#normalizePath);
    return this.#serialize(normalizedPath, async () => {
      const created = await this.#create(normalizedPath, content);
      // Transfer rollback ownership before read-back can fail. Unowned save callers
      // retain their existing policy of preserving an uncertain write.
      onCreated?.(created);
      const readBack = await this.#readText(
        normalizedPath,
        maximumBytes,
        (file) => this.#vault.read(file),
        deferByteVerification,
      );
      return { ...created, readBack };
    });
  }

  pathExists(path: string): boolean {
    const normalizedPath = normalizeVaultPath(path, this.#normalizePath);
    const file = this.#vault.getFileByPath(normalizedPath);
    const folder = this.#vault.getFolderByPath(normalizedPath);
    return file instanceof this.#classes.file || folder instanceof this.#classes.folder;
  }

  fileExists(path: string): boolean {
    const normalizedPath = normalizeVaultPath(path, this.#normalizePath);
    return this.#vault.getFileByPath(normalizedPath) instanceof this.#classes.file;
  }

  #serialize<Result>(path: string, operation: () => Promise<Result>): Promise<Result> {
    const preceding = this.#operationsByPath.get(path) ?? Promise.resolve();
    const result = preceding.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#operationsByPath.set(path, tail);
    return result.finally(() => {
      if (this.#operationsByPath.get(path) === tail) this.#operationsByPath.delete(path);
    });
  }

  async #create(path: string, content: string): Promise<CreatedVaultFile> {
    const file = await this.#vault.create(path, content);
    if (!(file instanceof this.#classes.file) || file.path !== path) {
      throw new VaultBoundaryError("unexpected-host-result");
    }
    const identity = this.#verifyStableRead(path, file, snapshotIdentity(file));
    const generation = this.#modifications.get(file) ?? 0;
    return { file, isCurrent: () => this.#isCurrentRead(file, identity, generation) };
  }

  #readTextWithMetadataGuard(
    path: string,
    maximumBytes: number,
    read: (file: TFile) => Promise<string>,
  ): Promise<MetadataGuardedFileRead> {
    return this.#readWithMetadataGuard(path, maximumBytes, (normalizedPath) =>
      this.#readText(normalizedPath, maximumBytes, read),
    );
  }

  async #readText(
    normalizedPath: string,
    maximumBytes: number,
    read: (file: TFile) => Promise<string>,
    deferByteVerification = false,
  ): Promise<MetadataGuardedFileRead> {
    const file = this.resolveFile(normalizedPath);
    const before = snapshotIdentity(file);
    const generation = this.#modifications.get(file) ?? 0;
    assertSizeWithinLimit(before.size, maximumBytes);
    const content = await read(file);
    const identity = this.#verifyStableRead(normalizedPath, file, before);
    const isCurrent = () => this.#isCurrentRead(file, identity, generation);
    if (!isCurrent()) throw new VaultBoundaryError("unexpected-host-result");
    // UTF-16 length is a constant-time lower bound for UTF-8 bytes. Exact size is
    // checked by the worker or by comparison with the verified canonical export.
    assertSizeWithinLimit(content.length, maximumBytes);
    if (deferByteVerification)
      return new MetadataGuardedFileReadCandidate(content, identity, isCurrent);
    const verified = VerifiedMetadataGuardedFileRead.create(
      content,
      identity,
      maximumBytes,
      isCurrent,
    );
    if (verified === "too-large") throw new VaultBoundaryError("file-too-large");
    if (verified === "size-mismatch") throw new VaultBoundaryError("unexpected-host-result");
    return verified;
  }

  #isCurrentRead(file: TFile, identity: FileReadIdentity, generation: number): boolean {
    return (
      this.#vault.getFileByPath(identity.path) === file &&
      (this.#modifications.get(file) ?? 0) === generation &&
      sameIdentity(identity, snapshotIdentity(file))
    );
  }

  #verifyStableRead(path: string, file: TFile, before: FileReadIdentity): FileReadIdentity {
    const resolved = this.#vault.getFileByPath(path);
    if (resolved !== file || !(resolved instanceof this.#classes.file)) {
      throw new VaultBoundaryError("unexpected-host-result");
    }
    const after = snapshotIdentity(resolved);
    if (!sameIdentity(before, after)) {
      throw new VaultBoundaryError("unexpected-host-result");
    }
    return after;
  }
}

function assertMaximumBytes(maximumBytes: number): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new RangeError("maximumBytes must be a positive safe integer");
  }
}

function assertSizeWithinLimit(size: number, maximumBytes: number): void {
  if (size > maximumBytes) throw new VaultBoundaryError("file-too-large");
}

function snapshotIdentity(file: TFile): FileReadIdentity {
  const identity = { ...file.stat, path: file.path };
  if (
    !Number.isSafeInteger(identity.ctime) ||
    identity.ctime < 0 ||
    !Number.isSafeInteger(identity.mtime) ||
    identity.mtime < 0 ||
    !Number.isSafeInteger(identity.size) ||
    identity.size < 0
  ) {
    throw new VaultBoundaryError("unexpected-host-result");
  }
  return identity;
}

function sameIdentity(left: FileReadIdentity, right: FileReadIdentity): boolean {
  return (
    left.path === right.path &&
    left.ctime === right.ctime &&
    left.mtime === right.mtime &&
    left.size === right.size
  );
}
