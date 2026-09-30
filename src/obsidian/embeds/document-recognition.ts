import { TFile, type Vault } from "obsidian";

import { adoptOwnedSvgOutputSync } from "../../persistence/scheduling/owned-svg-output";
import type { MetadataGuardedFileRead } from "../../persistence/saving/save-ports";
import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { createRecognitionWorkScheduler } from "./document-recognition-scheduler";
import { samePreviewContentIdentity, type PreviewContentIdentity } from "./safe-preview-svg";
import { inspectPreviewSvg, type LoadedPreviewSvg } from "./safe-preview-svg";

const MAXIMUM_RECOGNITION_CACHE_ENTRIES = 256;
const MAXIMUM_RECOGNITION_MARKUP_CODE_UNITS = 32 * 1024 * 1024;
const MAXIMUM_ROOT_TAG_CHARACTERS = 4096;
const MAXIMUM_ACTIVE_READS = 4;
const MAXIMUM_QUEUED_READS = 4096;
interface RecognitionEntry {
  readonly confirmedFile?: TFile;
  pendingRefresh?: boolean;
  readonly signature: string;
  readonly value: InkbookDocumentRecognition;
}

interface PendingRecognition {
  readonly abort: AbortController;
  readonly owners: Set<Window>;
  readonly ownerReleases: Map<Window, () => void>;
  selectedOwner: Window | null;
  schedulerAbort: AbortController;
  readonly file: TFile;
  readonly signature: string;
  readonly promise: Promise<InkbookDocumentRecognition>;
  readonly resolve: (value: InkbookDocumentRecognition) => void;
  readonly gates: Set<() => Promise<void> | undefined>;
}

export type InkbookDocumentRecognition = false | LoadedPreviewSvg;

export interface InkbookDocumentRecognitionPort {
  cached(documentId: string): InkbookDocumentRecognition | undefined;
  recognize(documentId: string, ownerWindow?: Window | null): Promise<InkbookDocumentRecognition>;
  subscribe(listener: (documentId: string) => void): () => void;
  loadPreviewSource?: (
    documentId: string,
    source: string,
    waitForBackground?: () => Promise<void> | undefined,
    ownerWindow?: Window | null,
  ) => Promise<LoadedPreviewSvg>;
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
  readonly #workScheduler: (ownerWindow: Window | null) => WorkScheduler;
  #disposed = false;

  public constructor(
    vault: Vault,
    options: {
      readonly deferUntilLayoutReady?: boolean;
      readonly workScheduler: WorkScheduler | ((ownerWindow: Window | null) => WorkScheduler);
    },
  ) {
    this.#vault = vault;
    const workScheduler = options.workScheduler;
    this.#workScheduler = typeof workScheduler === "function" ? workScheduler : () => workScheduler;
    this.#layoutReady = options.deferUntilLayoutReady !== true;
  }

  public markLayoutReady(): void {
    this.#layoutReady = true;
    queueMicrotask(() => this.#drain());
  }

  public readonly loadPreviewSource = async (
    documentId: string,
    source: string,
    waitForBackground?: () => Promise<void> | undefined,
    ownerWindow?: Window | null,
  ): Promise<LoadedPreviewSvg> => {
    const file = this.#resolveFile(documentId);
    const identity = previewSourceIdentity(source);
    if (
      file === undefined ||
      identity === undefined ||
      !matchesPreviewResource(this.#vault, file, source)
    )
      throw new Error("The Inkbook preview source does not match its file.");
    const signature = fileSignature(file);
    const cached = this.#entries.get(documentId);
    if (cached !== undefined && !cached.pendingRefresh && cached.signature === signature) {
      this.#touch(documentId, cached);
      if (
        cached.value === false ||
        !samePreviewContentIdentity(cached.value.contentIdentity, identity)
      )
        throw new Error("The Inkbook preview source changed while loading.");
      return cached.value;
    }
    if (cached !== undefined) this.#deleteEntry(documentId);
    const pending = this.recognize(documentId, ownerWindow);
    const request = this.#pending.get(documentId);
    if (waitForBackground !== undefined) request?.gates.add(waitForBackground);
    const value = await pending;
    if (
      value === false ||
      this.#resolveFile(documentId) !== file ||
      fileSignature(file) !== signature ||
      !samePreviewContentIdentity(value.contentIdentity, identity)
    )
      throw new Error("The Inkbook preview source changed while loading.");
    return value;
  };

  public cached(documentId: string): InkbookDocumentRecognition | undefined {
    const file = this.#resolveFile(documentId);
    if (file === undefined) return false;
    const entry = this.#entries.get(documentId);
    if (entry === undefined || (!entry.pendingRefresh && entry.signature !== fileSignature(file)))
      return undefined;
    this.#touch(documentId, entry);
    return entry.value;
  }

  /** Only a confirmed own writer readback can authorize skipping canonical validation. */
  public matchesConfirmedOutput(read: MetadataGuardedFileRead): boolean {
    const file = this.#resolveFile(read.identity.path);
    const entry = this.#entries.get(read.identity.path);
    return (
      file !== undefined &&
      entry?.confirmedFile === file &&
      !entry.pendingRefresh &&
      entry.signature === fileSignature(file) &&
      read.identity.ctime === file.stat.ctime &&
      read.identity.mtime === file.stat.mtime &&
      read.identity.size === file.stat.size &&
      entry.value !== false &&
      read.content === entry.value.safeSvg
    );
  }

  public recognize(
    documentId: string,
    ownerWindow?: Window | null,
  ): Promise<InkbookDocumentRecognition> {
    const file = this.#resolveFile(documentId);
    if (file === undefined) return Promise.resolve(false);
    const signature = fileSignature(file);
    const current = this.#entries.get(documentId);
    if (current !== undefined && (current.pendingRefresh || current.signature === signature)) {
      this.#touch(documentId, current);
      return Promise.resolve(current.value);
    }
    const pending = this.#pending.get(documentId);
    if (pending?.signature === signature) {
      this.#addOwner(pending, ownerWindow);
      return pending.promise;
    }
    this.#cancelPending(documentId);
    if (this.#queue.size >= MAXIMUM_QUEUED_READS) return Promise.resolve(false);
    let resolve!: (value: InkbookDocumentRecognition) => void;
    const promise = new Promise<InkbookDocumentRecognition>((settle) => {
      resolve = settle;
    });
    const request = {
      abort: new AbortController(),
      owners: new Set<Window>(),
      ownerReleases: new Map<Window, () => void>(),
      selectedOwner: null,
      schedulerAbort: new AbortController(),
      file,
      signature,
      promise,
      resolve,
      gates: new Set<() => Promise<void> | undefined>(),
    };
    this.#addOwner(request, ownerWindow);
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
      void this.#readMarker(request).then(
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
    this.#releaseOwners(request);
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
    request.abort.abort();
    request.schedulerAbort.abort();
    this.#releaseOwners(request);
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

  /** Retain the last safe presentation while the host distinguishes its own write. */
  public deferRefresh(documentId: string): void {
    const cancelled = this.#cancelPending(documentId);
    const entry = this.#entries.get(documentId);
    if (entry !== undefined) entry.pendingRefresh = true;
    else if (cancelled) {
      const file = this.#resolveFile(documentId);
      if (file !== undefined)
        this.#entries.set(documentId, {
          pendingRefresh: true,
          signature: fileSignature(file),
          value: false,
        });
      this.#evictOverflow();
    }
  }

  /** Called only after fresh Vault bytes match a confirmed canonical writer output. */
  public acceptConfirmedOutput(
    documentId: string,
    content: string,
    outputHash: string,
    signature: string,
  ): void {
    const file = this.#resolveFile(documentId);
    if (file === undefined) return;
    if (fileSignature(file) !== signature) {
      this.invalidate(documentId);
      return;
    }
    const output = adoptOwnedSvgOutputSync(content, outputHash);
    this.#cancelPending(documentId);
    this.#deleteEntry(documentId);
    const value = immutablePreview({
      aspectRatio: 2048.6 / output.lockedHeight,
      contentIdentity: { outputHash, revision: output.revision },
      safeSvg: content,
    });
    this.#entries.set(documentId, { confirmedFile: file, signature, value });
    this.#markupCodeUnits += content.length;
    this.#evictOverflow();
    this.#notify(documentId);
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

  #addOwner(request: PendingRecognition, ownerWindow: Window | null | undefined): void {
    if (ownerWindow === null || ownerWindow === undefined || ownerWindow.closed) return;
    if (!request.ownerReleases.has(ownerWindow)) {
      const ownerDocument = ownerWindow.document;
      const onVisibilityChange = (): void => this.#refreshOwner(request);
      const onUnload = (): void => {
        request.ownerReleases.get(ownerWindow)?.();
        request.ownerReleases.delete(ownerWindow);
        request.owners.delete(ownerWindow);
        this.#refreshOwner(request);
      };
      ownerDocument.addEventListener("visibilitychange", onVisibilityChange);
      ownerWindow.addEventListener("unload", onUnload, { once: true });
      request.ownerReleases.set(ownerWindow, () => {
        ownerDocument.removeEventListener("visibilitychange", onVisibilityChange);
        ownerWindow.removeEventListener("unload", onUnload);
      });
    }
    request.owners.delete(ownerWindow);
    request.owners.add(ownerWindow);
    this.#refreshOwner(request);
  }

  #refreshOwner(request: PendingRecognition): void {
    const next = this.#chosenOwner(request);
    if (request.selectedOwner === next) return;
    request.selectedOwner = next;
    request.schedulerAbort.abort();
    request.schedulerAbort = new AbortController();
  }

  #releaseOwners(request: PendingRecognition): void {
    for (const release of request.ownerReleases.values()) release();
    request.ownerReleases.clear();
    request.owners.clear();
    request.selectedOwner = null;
  }

  #chosenOwner(request: PendingRecognition): Window | null {
    let visible: Window | null = null;
    let hidden: Window | null = null;
    for (const owner of request.owners) {
      if (owner.closed) continue;
      if (owner.document.visibilityState === "hidden") hidden = owner;
      else visible = owner;
    }
    return visible ?? hidden;
  }

  /** Forward each validation checkpoint to the current requester's shared window scheduler. */
  #requestScheduler(request: PendingRecognition): WorkScheduler {
    return createRecognitionWorkScheduler(
      () => {
        if (request.selectedOwner?.closed) this.#refreshOwner(request);
        return this.#workScheduler(request.selectedOwner);
      },
      () => request.schedulerAbort.signal,
      request.abort.signal,
    );
  }

  async #readMarker(request: PendingRecognition): Promise<InkbookDocumentRecognition> {
    const { file, signature, abort } = request;
    if (abort.signal.aborted) return false;
    if (this.#resolveFile(file.path) !== file || fileSignature(file) !== signature) return false;
    if (file.stat.size < 0 || file.stat.size > FILE_SCHEMA_LIMITS.totalInputBytes) return false;
    try {
      const content = await this.#vault.cachedRead(file);
      const current = this.#resolveFile(file.path);
      if (abort.signal.aborted || current !== file || fileSignature(current) !== signature)
        return false;
      const descriptor = recognizeCanonicalInkbookRoot(content);
      if (descriptor === false) return false;
      const workScheduler = this.#requestScheduler(request);
      let preview: LoadedPreviewSvg | null;
      try {
        preview = await inspectPreviewSvg(content, {
          waitForBackground: () => {
            const pending: Promise<void>[] = [];
            for (const gate of request.gates) {
              const ready = gate();
              if (ready !== undefined) pending.push(ready);
            }
            return pending.length === 0 ? undefined : Promise.all(pending).then(() => undefined);
          },
          signal: abort.signal,
          workScheduler,
        });
      } finally {
        workScheduler.dispose();
      }
      const confirmed = this.#resolveFile(file.path);
      return preview !== null && confirmed === file && fileSignature(confirmed) === signature
        ? immutablePreview({ ...preview, aspectRatio: descriptor.aspectRatio })
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

function previewSourceIdentity(source: string): PreviewContentIdentity | undefined {
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

function immutablePreview(value: LoadedPreviewSvg): LoadedPreviewSvg {
  Object.freeze(value.contentIdentity);
  return Object.freeze(value);
}

function matchesPreviewResource(vault: Vault, file: TFile, source: string): boolean {
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
