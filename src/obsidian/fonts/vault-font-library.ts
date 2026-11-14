import { normalizePath, type Component, type Vault } from "obsidian";
import type { FontLibraryEntryV2 } from "../../domain/settings";
import type { FontResourceV2 } from "../../domain/schema/types";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { FONT_LIMITS } from "../../persistence/fonts/font-container";
import { createFontResource, type FontDescriptor } from "../../persistence/fonts/font-resources";
import { assertAvailableFamilyFace, resolveImportedFontFamily } from "./font-library-families";
import {
  FontImportError,
  FontImportStaging,
  type PreparedLibraryFontFace,
} from "./font-import-staging";
import { planFontImport, type FontImportSelection } from "./font-import-plan";

export { FontImportError, type PreparedLibraryFontFace } from "./font-import-staging";

export type LibraryFontFace = FontLibraryEntryV2;

export interface FontLibraryMetadata {
  read(): readonly LibraryFontFace[];
  write(faces: readonly LibraryFontFace[]): Promise<void>;
}

export interface VaultFontLibraryOptions {
  readonly vault: Vault;
  readonly scheduler: WorkScheduler | (() => WorkScheduler);
  readonly metadata: FontLibraryMetadata;
  readonly owner: Component;
  /** Must use the owning window's native FontFace.load before accepting imported bytes. */
  readonly sanitize: (bytes: Uint8Array<ArrayBuffer>, face: FontDescriptor) => Promise<void>;
}

const FOLDER = "Inkbook Fonts";

/** Stores local vault binaries; settings retain only a bounded face index. */
export class VaultFontLibrary {
  readonly #options: VaultFontLibraryOptions;
  #queue: Promise<unknown> = Promise.resolve();
  #disposed = false;
  #importPending = false;
  readonly #staging = new FontImportStaging();

  public constructor(options: VaultFontLibraryOptions) {
    this.#options = options;
    options.owner.register(() => {
      this.#disposed = true;
      this.#staging.dispose();
    });
  }

  public list(): readonly LibraryFontFace[] {
    this.#assertLive();
    const faces = this.#options.metadata.read();
    if (faces.length > FONT_LIMITS.libraryFaces)
      throw new RangeError("Font library exceeds limit.");
    return faces.map((face) => ({ ...face }));
  }

  public import(
    bytes: Uint8Array,
    descriptor: FontDescriptor,
    displayName: string,
    useMetadata = false,
  ): Promise<LibraryFontFace> {
    if (bytes.length > FONT_LIMITS.fileBytes)
      return Promise.reject(new RangeError("Font exceeds limit."));
    if (this.#importPending) return Promise.reject(new Error("A font import is already pending."));
    this.#importPending = true;
    let prepared: PreparedLibraryFontFace | undefined;
    const preparation = this.#staging.prepare(
      bytes,
      { descriptor, fallbackName: displayName, useMetadata },
      this.#scheduler(),
      this.#options.sanitize,
    );
    return preparation
      .then((result) => {
        prepared = result;
        return this.#serialize(async () => {
          const resource = result.resource;
          const owned = this.#staging.bytes(result);
          this.#assertLive();
          const faces = this.list();
          const family = resolveImportedFontFamily(faces, descriptor.family, resource.id);
          const existing = faces.find((face) => face.id === resource.id);
          if (existing !== undefined) {
            await this.#ensureBinary(existing.path, owned);
            if (existing.family === family) return existing;
            return this.#assignFace(existing, family, faces);
          }
          if (faces.length >= FONT_LIMITS.libraryFaces)
            throw new RangeError("Font library is full.");
          const actualName = useMetadata ? result.familyName : displayName;
          if (actualName.trim().length === 0 || actualName.length > 128)
            throw new RangeError("Invalid font display name.");
          const extension = resource.mimeType.slice(5);
          const path = normalizePath(`${FOLDER}/${resource.id}.${extension}`);
          const face: LibraryFontFace = {
            ...descriptor,
            weight: resource.weight,
            style: resource.style,
            ...(resource.weightRange === undefined ? {} : { weightRange: resource.weightRange }),
            family,
            id: resource.id,
            path,
            displayName: actualName,
          };
          assertAvailableFamilyFace(faces, face);
          await this.#ensureBinary(path, owned);
          this.#assertLive();
          await this.#options.metadata.write([...faces, face]);
          return face;
        });
      })
      .finally(() => {
        if (prepared !== undefined) this.#staging.release(prepared);
        this.#importPending = false;
      });
  }

  /** Validates and prepares preview data without writing binaries or metadata. */
  public async prepareImport(
    bytes: Uint8Array,
    fallbackName: string,
    signal?: AbortSignal,
  ): Promise<PreparedLibraryFontFace> {
    this.#assertLive();
    return this.#staging.prepare(
      bytes,
      {
        descriptor: { family: "upload", weight: 400, style: "normal" },
        fallbackName,
        useMetadata: true,
      },
      this.#scheduler(),
      this.#options.sanitize,
      signal,
    );
  }

  /** Commits one reviewed family in a single metadata transaction, reusing validated bytes. */
  public commitImport(
    prepared: readonly PreparedLibraryFontFace[],
    selection: FontImportSelection,
    signal?: AbortSignal,
  ): Promise<readonly LibraryFontFace[]> {
    if (prepared.length > FONT_LIMITS.libraryFaces)
      return Promise.reject(new FontImportError("invalid-prepared", "Too many prepared fonts."));
    const batch = [...prepared];
    const target = { ...selection };
    return this.#serialize(async () => {
      for (const item of batch) this.#staging.bytes(item, signal);
      const imported = planFontImport(batch, this.list(), target);
      for (const face of imported) {
        const item = batch.find((candidate) => candidate.id === face.id)!;
        await this.#ensureBinary(face.path, this.#staging.bytes(item, signal), signal);
        this.#assertLive();
      }
      for (const item of batch) this.#staging.bytes(item, signal);
      const faces = this.list();
      const current = planFontImport(batch, faces, target);
      const additions = current.filter((face) => !faces.some((item) => item.id === face.id));
      if (additions.length > 0) await this.#options.metadata.write([...faces, ...additions]);
      for (const item of batch) this.#staging.release(item);
      return current;
    });
  }

  public releasePrepared(prepared: PreparedLibraryFontFace): void {
    this.#staging.release(prepared);
  }

  public renameFamily(family: string, displayName: string): Promise<void> {
    return this.#serialize(async () => {
      const name = displayName.trim();
      if (name.length === 0 || name.length > 128)
        throw new FontImportError("invalid-name", "Invalid font display name.");
      const faces = this.list();
      const matching = faces.filter((face) => face.family === family);
      if (matching.length === 0)
        throw new FontImportError("unavailable-family", "The selected font family is unavailable.");
      if (matching.every((face) => face.displayName === name)) return;
      await this.#options.metadata.write(
        faces.map((face) => (face.family === family ? { ...face, displayName: name } : face)),
      );
    });
  }

  async #assignFace(
    face: LibraryFontFace,
    family: string,
    faces: readonly LibraryFontFace[],
  ): Promise<LibraryFontFace> {
    const assigned = { ...face, family };
    assertAvailableFamilyFace(faces, assigned);
    await this.#options.metadata.write(
      faces.map((current) => (current.id === face.id ? assigned : current)),
    );
    return assigned;
  }

  public async resource(
    face: LibraryFontFace,
    signal?: AbortSignal,
    scheduler?: WorkScheduler,
  ): Promise<FontResourceV2> {
    this.#assertLive();
    if (!this.list().some((candidate) => candidate.id === face.id && candidate.path === face.path))
      throw new RangeError("Font is not in the library.");
    if (!new RegExp(`^${FOLDER}/[a-f0-9]{64}\\.(ttf|otf|woff|woff2)$`).test(face.path))
      throw new RangeError("Invalid font path.");
    const file = this.#options.vault.getFileByPath(face.path);
    if (file === null || file.stat.size > FONT_LIMITS.fileBytes)
      throw new RangeError("Font file unavailable or too large.");
    const bytes = new Uint8Array(await this.#options.vault.readBinary(file));
    signal?.throwIfAborted();
    const resource = await createFontResource(bytes, face, scheduler ?? this.#scheduler(), signal);
    this.#assertLive();
    if (resource.id !== face.id) throw new RangeError("Font file content changed.");
    return resource;
  }

  /** Existing documents retain their embedded bytes when the library entry is removed. */
  public remove(id: string): Promise<void> {
    return this.#serialize(async () => {
      const faces = this.list();
      await this.#options.metadata.write(faces.filter((face) => face.id !== id));
    });
  }

  async #ensureBinary(
    path: string,
    bytes: Uint8Array<ArrayBuffer>,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    this.#assertLive();
    const { vault } = this.#options;
    if (vault.getAbstractFileByPath(FOLDER) === null) await vault.createFolder(FOLDER);
    signal?.throwIfAborted();
    this.#assertLive();
    const existing = vault.getFileByPath(path);
    if (existing === null) {
      await vault.createBinary(path, bytes.buffer);
      return;
    }
    if (existing.stat.size !== bytes.length)
      throw new RangeError("Font library content collision.");
    const actual = new Uint8Array(await vault.readBinary(existing));
    if (actual.length !== bytes.length) throw new RangeError("Font library content collision.");
    for (let offset = 0; offset < actual.length; offset += 4096) {
      if (
        actual.subarray(offset, offset + 4096).some((byte, index) => byte !== bytes[offset + index])
      )
        throw new RangeError("Font library content collision.");
      const pending = this.#scheduler().checkpoint(signal, "background");
      if (pending !== undefined) await pending;
      signal?.throwIfAborted();
      this.#assertLive();
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(() => {
      this.#assertLive();
      return operation();
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #scheduler(): WorkScheduler {
    const scheduler = this.#options.scheduler;
    return typeof scheduler === "function" ? scheduler() : scheduler;
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error("Font library disposed.");
  }
}

/** Safe native admission for one owning document/window; does not retain a global font. */
export async function sanitizeImportedFont(
  bytes: Uint8Array<ArrayBuffer>,
  descriptor: FontDescriptor,
  createFace: (family: string, bytes: ArrayBuffer, descriptors: FontFaceDescriptors) => FontFace,
): Promise<void> {
  const face = createFace("inkbook-import-check", bytes.buffer, {
    weight: String(descriptor.weight),
    style: descriptor.style,
  });
  await face.load();
}
