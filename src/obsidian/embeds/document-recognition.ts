import { TFile, type Vault } from "obsidian";

import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";
import { inspectPreviewSvg, type LoadedPreviewSvg } from "./safe-preview-svg";

const MAXIMUM_RECOGNITION_CACHE_ENTRIES = 256;
const MAXIMUM_RECOGNITION_MARKUP_CODE_UNITS = 32 * 1024 * 1024;
const MAXIMUM_ROOT_TAG_CHARACTERS = 4096;
const MAXIMUM_ACTIVE_READS = 4;
const MAXIMUM_QUEUED_READS = 4096;

interface RecognitionEntry {
  readonly signature: string;
  readonly value: InkbookDocumentRecognition;
}

interface PendingRecognition {
  readonly file: TFile;
  readonly signature: string;
  readonly promise: Promise<InkbookDocumentRecognition>;
  readonly resolve: (value: InkbookDocumentRecognition) => void;
}

export type InkbookDocumentRecognition = false | LoadedPreviewSvg;

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

function recognizeCanonicalInkbookRoot(content: string): false | { readonly aspectRatio: number } {
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
  readonly #pending = new Map<string, PendingRecognition>();
  readonly #queue = new Map<string, PendingRecognition>();
  #activeReads = 0;
  #markupCodeUnits = 0;
  #layoutReady: boolean;
  readonly #sliceBudgetMs: (() => number) | undefined;
  #disposed = false;

  public constructor(
    vault: Vault,
    options: {
      readonly deferUntilLayoutReady?: boolean;
      readonly sliceBudgetMs?: () => number;
    } = {},
  ) {
    this.#vault = vault;
    this.#sliceBudgetMs = options.sliceBudgetMs;
    this.#layoutReady = options.deferUntilLayoutReady !== true;
  }

  public markLayoutReady(): void {
    this.#layoutReady = true;
    queueMicrotask(() => this.#drain());
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
      return Promise.resolve(current.value);
    }
    const pending = this.#pending.get(documentId);
    if (pending?.signature === signature) return pending.promise;
    this.#cancelPending(documentId);
    if (this.#queue.size >= MAXIMUM_QUEUED_READS) return Promise.resolve(false);
    let resolve!: (value: InkbookDocumentRecognition) => void;
    const promise = new Promise<InkbookDocumentRecognition>((settle) => {
      resolve = settle;
    });
    const request = { file, signature, promise, resolve };
    this.#pending.set(documentId, request);
    this.#queue.set(documentId, request);
    this.#drain();
    return promise;
  }

  #drain(): void {
    if (this.#disposed || !this.#layoutReady) return;
    while (this.#activeReads < MAXIMUM_ACTIVE_READS) {
      const next = this.#queue.entries().next().value;
      if (next === undefined) return;
      const [documentId, request] = next;
      this.#queue.delete(documentId);
      this.#activeReads += 1;
      void this.#readMarker(request.file, request.signature).then(
        (value) => this.#complete(documentId, request, value),
        () => this.#complete(documentId, request, false),
      );
    }
  }

  #complete(
    documentId: string,
    request: PendingRecognition,
    value: InkbookDocumentRecognition,
  ): void {
    this.#activeReads -= 1;
    if (this.#pending.get(documentId) === request) {
      this.#pending.delete(documentId);
      this.#deleteEntry(documentId);
      this.#entries.set(documentId, { signature: request.signature, value });
      this.#markupCodeUnits += value === false ? 0 : value.safeSvg.length;
      this.#evictOverflow();
      request.resolve(value);
      this.#notify(documentId);
    }
    this.#drain();
  }

  #cancelPending(documentId: string): boolean {
    const request = this.#pending.get(documentId);
    if (request === undefined) return false;
    this.#pending.delete(documentId);
    this.#queue.delete(documentId);
    request.resolve(false);
    return true;
  }

  public subscribe(listener: (documentId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  public invalidate(documentId: string): void {
    const pending = this.#cancelPending(documentId);
    if (!this.#deleteEntry(documentId) && !pending) return;
    this.#notify(documentId);
  }

  public dispose(): void {
    this.#disposed = true;
    for (const documentId of this.#pending.keys()) this.#cancelPending(documentId);
    this.#markupCodeUnits = 0;
    this.#entries.clear();
    this.#listeners.clear();
  }

  async #readMarker(file: TFile, signature: string): Promise<InkbookDocumentRecognition> {
    if (this.#resolveFile(file.path) !== file || fileSignature(file) !== signature) return false;
    if (file.stat.size < 0 || file.stat.size > FILE_SCHEMA_LIMITS.totalInputBytes) return false;
    try {
      const content = await this.#vault.cachedRead(file);
      const current = this.#resolveFile(file.path);
      if (current !== file || fileSignature(current) !== signature) return false;
      const descriptor = recognizeCanonicalInkbookRoot(content);
      if (descriptor === false) return false;
      const preview = await inspectPreviewSvg(content, undefined, undefined, this.#sliceBudgetMs);
      const confirmed = this.#resolveFile(file.path);
      return preview !== null && confirmed === file && fileSignature(confirmed) === signature
        ? { ...preview, aspectRatio: descriptor.aspectRatio }
        : false;
    } catch {
      return false;
    }
  }

  #resolveFile(documentId: string): TFile | undefined {
    if (this.#disposed) return undefined;
    const file = this.#vault.getFileByPath(documentId);
    return file instanceof TFile && file.extension.toLowerCase() === "svg" ? file : undefined;
  }

  #touch(documentId: string, entry: RecognitionEntry): void {
    this.#entries.delete(documentId);
    this.#entries.set(documentId, entry);
  }

  #evictOverflow(): void {
    while (
      this.#entries.size > MAXIMUM_RECOGNITION_CACHE_ENTRIES ||
      (this.#entries.size > 1 && this.#markupCodeUnits > MAXIMUM_RECOGNITION_MARKUP_CODE_UNITS)
    ) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) return;
      this.#deleteEntry(oldest);
    }
  }

  #deleteEntry(documentId: string): boolean {
    const entry = this.#entries.get(documentId);
    if (entry === undefined) return false;
    this.#markupCodeUnits -= entry.value === false ? 0 : entry.value.safeSvg.length;
    return this.#entries.delete(documentId);
  }

  #notify(documentId: string): void {
    for (const listener of this.#listeners) {
      try {
        listener(documentId);
      } catch {
        // A failed presentation must not block other subscribers or queued recognition.
      }
    }
  }
}
