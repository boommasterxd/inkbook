import { FONT_LIMITS } from "../../../persistence/fonts/font-container";
import { FontImportError, type PreparedLibraryFontFace } from "../../fonts/font-import-staging";
import type { VaultFontLibrary } from "../../fonts/vault-font-library";

/** Owns one bounded, cancellable review draft; preparing files never persists the library. */
export class FontImportSelection {
  readonly #lifetime = new AbortController();
  #files: PreparedLibraryFontFace[] = [];

  public constructor(private readonly library: VaultFontLibrary) {}

  public get files(): readonly PreparedLibraryFontFace[] {
    return this.#files;
  }
  public get signal(): AbortSignal {
    return this.#lifetime.signal;
  }

  public async add(files: readonly File[]): Promise<void> {
    const prepared: PreparedLibraryFontFace[] = [];
    if (files.length + this.#files.length > FONT_LIMITS.libraryFaces)
      throw new FontImportError("staging-limit", "Too many selected files.");
    if (files.some((file) => file.size > FONT_LIMITS.fileBytes))
      throw new FontImportError("file-limit", "A selected file is too large.");
    try {
      for (const file of files) {
        this.signal.throwIfAborted();
        const bytes = new Uint8Array(await file.arrayBuffer());
        this.signal.throwIfAborted();
        const face = await this.library.prepareImport(bytes, file.name, this.signal);
        prepared.push(face);
        this.signal.throwIfAborted();
      }
      for (const face of prepared) {
        if (this.#files.some((current) => current.id === face.id))
          this.library.releasePrepared(face);
        else this.#files.push(face);
      }
    } catch (error) {
      for (const face of prepared) this.library.releasePrepared(face);
      throw error;
    }
  }

  public remove(id: string): void {
    for (const face of this.#files) if (face.id === id) this.library.releasePrepared(face);
    this.#files = this.#files.filter((face) => face.id !== id);
  }

  public dispose(): void {
    this.#lifetime.abort();
    for (const face of this.#files) this.library.releasePrepared(face);
    this.#files = [];
  }
}
