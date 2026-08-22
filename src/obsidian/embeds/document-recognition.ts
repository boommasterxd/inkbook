import { TFile, type Vault } from "obsidian";

import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";

const MAXIMUM_RECOGNITION_CACHE_ENTRIES = 256;
const MAXIMUM_ROOT_TAG_CHARACTERS = 4096;

interface RecognitionEntry {
  readonly promise: Promise<boolean> | undefined;
  readonly signature: string;
  readonly value: boolean | undefined;
}

export interface InkbookDocumentRecognitionPort {
  cached(documentId: string): boolean | undefined;
  recognize(documentId: string): Promise<boolean>;
  subscribe(listener: (documentId: string) => void): () => void;
}

function fileSignature(file: TFile): string {
  return `${String(file.stat.ctime)}:${String(file.stat.mtime)}:${String(file.stat.size)}`;
}

export function hasCanonicalInkbookRootMarker(content: string): boolean {
  const prefix = content.slice(0, MAXIMUM_ROOT_TAG_CHARACTERS).trimStart();
  if (!prefix.startsWith("<svg")) return false;
  const closing = prefix.indexOf(">");
  if (closing < 0) return false;
  const rootTag = prefix.slice(0, closing + 1);
  return /\sdata-inkbook-format=(?:"inkbook"|'inkbook')(?=\s|>)/u.test(rootTag);
}

export class ObsidianInkbookDocumentRecognition implements InkbookDocumentRecognitionPort {
  readonly #entries = new Map<string, RecognitionEntry>();
  readonly #listeners = new Set<(documentId: string) => void>();
  readonly #vault: Vault;

  public constructor(vault: Vault) {
    this.#vault = vault;
  }

  public cached(documentId: string): boolean | undefined {
    const file = this.#resolveFile(documentId);
    if (file === undefined) return false;
    const entry = this.#entries.get(documentId);
    if (entry === undefined || entry.signature !== fileSignature(file)) return undefined;
    this.#touch(documentId, entry);
    return entry.value;
  }

  public recognize(documentId: string): Promise<boolean> {
    const file = this.#resolveFile(documentId);
    if (file === undefined) return Promise.resolve(false);
    const signature = fileSignature(file);
    const current = this.#entries.get(documentId);
    if (current?.signature === signature) {
      this.#touch(documentId, current);
      return current.promise ?? Promise.resolve(current.value ?? false);
    }
    const promise = this.#readMarker(file, signature).then((value) => {
      const pending = this.#entries.get(documentId);
      if (pending?.promise !== promise) return value;
      this.#entries.set(documentId, { promise: undefined, signature, value });
      this.#notify(documentId);
      return value;
    });
    this.#entries.set(documentId, { promise, signature, value: undefined });
    this.#evictOverflow();
    return promise;
  }

  public subscribe(listener: (documentId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  public invalidate(documentId: string): void {
    if (!this.#entries.delete(documentId)) return;
    this.#notify(documentId);
  }

  public dispose(): void {
    this.#entries.clear();
    this.#listeners.clear();
  }

  async #readMarker(file: TFile, signature: string): Promise<boolean> {
    if (file.stat.size < 0 || file.stat.size > FILE_SCHEMA_LIMITS.totalInputBytes) return false;
    try {
      const content = await this.#vault.cachedRead(file);
      const current = this.#resolveFile(file.path);
      return (
        current === file &&
        fileSignature(current) === signature &&
        hasCanonicalInkbookRootMarker(content)
      );
    } catch {
      return false;
    }
  }

  #resolveFile(documentId: string): TFile | undefined {
    const file = this.#vault.getFileByPath(documentId);
    return file instanceof TFile && file.extension.toLowerCase() === "svg" ? file : undefined;
  }

  #touch(documentId: string, entry: RecognitionEntry): void {
    this.#entries.delete(documentId);
    this.#entries.set(documentId, entry);
  }

  #evictOverflow(): void {
    while (this.#entries.size > MAXIMUM_RECOGNITION_CACHE_ENTRIES) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) return;
      this.#entries.delete(oldest);
    }
  }

  #notify(documentId: string): void {
    for (const listener of this.#listeners) listener(documentId);
  }
}
