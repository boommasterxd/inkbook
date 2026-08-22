import { TFile, type Vault } from "obsidian";

import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";

const MAXIMUM_RECOGNITION_CACHE_ENTRIES = 256;
const MAXIMUM_ROOT_TAG_CHARACTERS = 4096;

interface RecognitionEntry {
  readonly promise: Promise<InkbookDocumentRecognition> | undefined;
  readonly signature: string;
  readonly value: InkbookDocumentRecognition | undefined;
}

export type InkbookDocumentRecognition = false | { readonly aspectRatio: number };

export interface InkbookDocumentRecognitionPort {
  cached(documentId: string): InkbookDocumentRecognition | undefined;
  recognize(documentId: string): Promise<InkbookDocumentRecognition>;
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

function recognizeCanonicalInkbookRoot(content: string): InkbookDocumentRecognition {
  const prefix = content.slice(0, MAXIMUM_ROOT_TAG_CHARACTERS).trimStart();
  if (!hasCanonicalInkbookRootMarker(prefix)) return false;
  const closing = prefix.indexOf(">");
  const rootTag = prefix.slice(0, closing + 1);
  const viewBox =
    /\sviewBox=(?:"0 0 2048\.6 ([0-9]+(?:\.[0-9]+)?)"|'0 0 2048\.6 ([0-9]+(?:\.[0-9]+)?)')(?=\s|>)/u.exec(
      rootTag,
    );
  const height = Number(viewBox?.[1] ?? viewBox?.[2]);
  if (!Number.isFinite(height) || height <= 0) return false;
  return { aspectRatio: 2048.6 / height };
}

export class ObsidianInkbookDocumentRecognition implements InkbookDocumentRecognitionPort {
  readonly #entries = new Map<string, RecognitionEntry>();
  readonly #listeners = new Set<(documentId: string) => void>();
  readonly #vault: Vault;

  public constructor(vault: Vault) {
    this.#vault = vault;
  }

  public cached(documentId: string): InkbookDocumentRecognition | undefined {
    const file = this.#resolveFile(documentId);
    if (file === undefined) return false;
    const entry = this.#entries.get(documentId);
    if (entry === undefined || entry.signature !== fileSignature(file)) return undefined;
    this.#touch(documentId, entry);
    return entry.value;
  }

  public recognize(documentId: string): Promise<InkbookDocumentRecognition> {
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

  async #readMarker(file: TFile, signature: string): Promise<InkbookDocumentRecognition> {
    if (file.stat.size < 0 || file.stat.size > FILE_SCHEMA_LIMITS.totalInputBytes) return false;
    try {
      const content = await this.#vault.cachedRead(file);
      const current = this.#resolveFile(file.path);
      return (
        current === file &&
        fileSignature(current) === signature &&
        recognizeCanonicalInkbookRoot(content)
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
