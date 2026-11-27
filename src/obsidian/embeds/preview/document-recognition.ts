import { TFile, type Vault } from "obsidian";

import { adoptOwnedSvgOutputSync } from "../../../persistence/scheduling/owned-svg-output";
import type { MetadataGuardedFileRead } from "../../../persistence/saving/save-ports";
import { FILE_SCHEMA_LIMITS } from "../../../domain/schema/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import {
  createRecognitionWorkScheduler,
  waitForRecognitionBackground,
  waitForRecognitionResult,
} from "./document-recognition-scheduler";
import {
  inspectPreviewSvg,
  recognizeCanonicalInkbookRoot,
  samePreviewContentIdentity,
  type LoadedPreviewSvg,
  type PreviewContentIdentity,
} from "./safe-preview-svg";
import { SafeStaticProof } from "../../../persistence/serialization/input/safe-static-proof";
import { matchesPreviewResource, previewSourceIdentity } from "./preview-resource-identity";
import { DocumentRecognitionSubscriptions } from "./document-recognition-subscriptions";

const MAXIMUM_RECOGNITION_CACHE_ENTRIES = 256;
const MAXIMUM_RECOGNITION_MARKUP_CODE_UNITS = 32 * 1024 * 1024;
const MAXIMUM_ACTIVE_READS = 4;
const MAXIMUM_QUEUED_READS = 4096;
interface RecognitionEntry {
  readonly file: TFile;
  readonly origin?: "recognized" | "confirmed";
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
  recognizeCurrent?: InkbookDocumentRecognitionPort["recognize"];
  canPublishPreview?(documentId: string, identity: PreviewContentIdentity): boolean;
  subscribe(listener: (documentId: string) => void, documentId?: string): () => void;
  loadPreviewSource?: (
    documentId: string,
    source: string | PreviewContentIdentity,
    waitForBackground?: () => Promise<void> | undefined,
    ownerWindow?: Window | null,
    signal?: AbortSignal,
  ) => Promise<LoadedPreviewSvg>;
}

function fileSignature(file: TFile): string {
  return `${String(file.stat.ctime)}:${String(file.stat.mtime)}:${String(file.stat.size)}`;
}

function isCurrentPreview(entry: RecognitionEntry, file: TFile, signature: string): boolean {
  return entry.file === file && entry.signature === signature;
}

export class ObsidianInkbookDocumentRecognition implements InkbookDocumentRecognitionPort {
  readonly #entries = new Map<string, RecognitionEntry>();
  readonly #deferred = new WeakSet<TFile>();
  readonly #validated = new WeakMap<
    TFile,
    { signature: string; identity: PreviewContentIdentity }
  >();
  readonly #subscriptions = new DocumentRecognitionSubscriptions();
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
    source: string | PreviewContentIdentity,
    waitForBackground?: () => Promise<void> | undefined,
    ownerWindow?: Window | null,
    signal?: AbortSignal,
  ): Promise<LoadedPreviewSvg> => {
    signal?.throwIfAborted();
    const file = this.#resolveFile(documentId);
    const identity = typeof source === "string" ? previewSourceIdentity(source) : source;
    if (
      file === undefined ||
      identity === undefined ||
      (typeof source === "string" && !matchesPreviewResource(this.#vault, file, source))
    )
      throw new Error("The Inkbook preview source does not match its file.");
    if (this.#deferred.has(file)) throw new Error("The Inkbook preview source is being refreshed.");
    const signature = fileSignature(file);
    const cached = this.#entries.get(documentId);
    if (cached !== undefined && isCurrentPreview(cached, file, signature)) {
      const value = requirePreviewIdentity(cached.value, identity);
      this.#touch(documentId, cached);
      return value;
    }
    const pending = this.recognize(documentId, ownerWindow);
    const gates = this.#pending.get(documentId)?.gates;
    await waitForRecognitionResult(pending, gates, waitForBackground, signal);
    signal?.throwIfAborted();
    const current = this.#entries.get(documentId);
    if (
      this.#resolveFile(documentId) !== file ||
      fileSignature(file) !== signature ||
      this.#deferred.has(file) ||
      current === undefined ||
      !isCurrentPreview(current, file, signature)
    )
      throw new Error("The Inkbook preview source changed while loading.");
    return requirePreviewIdentity(current.value, identity);
  };

  public cached(documentId: string): InkbookDocumentRecognition | undefined {
    const file = this.#resolveFile(documentId);
    if (file === undefined) return false;
    if (this.#deferred.has(file)) return undefined;
    const entry = this.#entries.get(documentId);
    if (entry === undefined || !isCurrentPreview(entry, file, fileSignature(file)))
      return undefined;
    this.#touch(documentId, entry);
    return entry.value;
  }

  public canPublishPreview(documentId: string, identity: PreviewContentIdentity): boolean {
    const file = this.#resolveFile(documentId);
    const validated = file === undefined ? undefined : this.#validated.get(file);
    return (
      file !== undefined &&
      validated?.signature === fileSignature(file) &&
      samePreviewContentIdentity(validated.identity, identity)
    );
  }

  /** Only current lifecycle-owned preview validation authorizes static scan reuse. */
  public safeStaticProof(documentId: string): SafeStaticProof | undefined {
    const file = this.#resolveFile(documentId);
    const entry = this.#entries.get(documentId);
    if (
      file === undefined ||
      this.#deferred.has(file) ||
      entry?.origin !== "recognized" ||
      !isCurrentPreview(entry, file, fileSignature(file)) ||
      entry.value === false
    )
      return undefined;
    const proof = entry.value.safeStaticProof;
    return SafeStaticProof.isAuthentic(proof) ? proof : undefined;
  }

  /** Only a confirmed own writer readback can authorize skipping canonical validation. */
  public matchesConfirmedOutput(read: MetadataGuardedFileRead): boolean {
    const file = this.#resolveFile(read.identity.path);
    const entry = this.#entries.get(read.identity.path);
    return (
      file !== undefined &&
      !this.#deferred.has(file) &&
      entry?.origin === "confirmed" &&
      isCurrentPreview(entry, file, fileSignature(file)) &&
      read.identity.ctime === file.stat.ctime &&
      read.identity.mtime === file.stat.mtime &&
      read.identity.size === file.stat.size &&
      entry.value !== false &&
      read.content === entry.value.safeSvg
    );
  }

  public recognizeCurrent(
    documentId: string,
    ownerWindow?: Window | null,
  ): Promise<InkbookDocumentRecognition> {
    const file = this.#resolveFile(documentId);
    if (file !== undefined && this.#deferred.delete(file)) this.#deleteEntry(documentId);
    return this.recognize(documentId, ownerWindow);
  }
  public recognize(
    documentId: string,
    ownerWindow?: Window | null,
  ): Promise<InkbookDocumentRecognition> {
    const file = this.#resolveFile(documentId);
    // A deferred read has no result. Only a cached false disqualifies an existing embed.
    if (file === undefined || this.#deferred.has(file)) return Promise.resolve(false);
    const signature = fileSignature(file);
    const current = this.#entries.get(documentId);
    if (current !== undefined && isCurrentPreview(current, file, signature)) {
      this.#touch(documentId, current);
      return Promise.resolve(current.value);
    }
    const pending = this.#pending.get(documentId);
    if (pending?.file === file && pending.signature === signature) {
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
      const { file, signature, resolve } = request;
      if (
        this.#resolveFile(documentId) === file &&
        !this.#deferred.has(file) &&
        fileSignature(file) === signature
      ) {
        this.#store(documentId, { file, origin: "recognized", signature, value });
        resolve(value);
        this.#subscriptions.notify(documentId);
      } else resolve(false);
    }
    this.#drain();
  }

  #cancelPending(documentId: string): void {
    const request = this.#pending.get(documentId);
    if (request === undefined) return;
    request.abort.abort();
    request.schedulerAbort.abort();
    this.#releaseOwners(request);
    this.#pending.delete(documentId);
    this.#queue.delete(documentId);
    request.resolve(false);
  }

  public subscribe(listener: (documentId: string) => void, documentId?: string): () => void {
    return this.#subscriptions.subscribe(listener, documentId);
  }

  /** Retain the last safe presentation while the host distinguishes its own write. */
  public deferRefresh(documentId: string): void {
    const file = this.#resolveFile(documentId);
    if (file !== undefined) {
      this.#deferred.add(file);
      this.#validated.delete(file);
    }
    this.#cancelPending(documentId);
  }

  /** Called only after fresh Vault bytes match a confirmed canonical writer output. */
  public acceptConfirmedOutput(
    documentId: string,
    content: string,
    outputHash: string,
    signature: string,
  ): void {
    const file = this.#resolveFile(documentId);
    if (file === undefined || fileSignature(file) !== signature) return;
    const output = adoptOwnedSvgOutputSync(content, outputHash);
    this.#deferred.delete(file);
    this.#cancelPending(documentId);
    const value = immutablePreview({
      aspectRatio: 2048.6 / output.lockedHeight,
      contentIdentity: { outputHash, revision: output.revision },
      safeSvg: content,
    });
    this.#store(documentId, { file, origin: "confirmed", signature, value });
    this.#subscriptions.notify(documentId);
  }

  public invalidate(documentId: string): void {
    const file = this.#resolveFile(documentId);
    if (file !== undefined) {
      this.#deferred.delete(file);
      this.#validated.delete(file);
    }
    this.#cancelPending(documentId);
    this.#deleteEntry(documentId);
    this.#subscriptions.notify(documentId);
  }

  public dispose(): void {
    this.#disposed = true;
    for (const documentId of this.#pending.keys()) this.#cancelPending(documentId);
    this.#markupCodeUnits = 0;
    this.#entries.clear();
    this.#subscriptions.clear();
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
      const preview = await inspectPreviewSvg(content, {
        waitForBackground: () => waitForRecognitionBackground(request.gates),
        signal: abort.signal,
        workScheduler,
      }).finally(() => workScheduler.dispose());
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

  #store(documentId: string, entry: RecognitionEntry): void {
    const { file, signature, value } = entry;
    this.#deleteEntry(documentId);
    this.#entries.set(documentId, entry);
    if (value === false) this.#validated.delete(file);
    else {
      this.#validated.set(file, { signature, identity: value.contentIdentity });
      this.#markupCodeUnits += value.safeSvg.length;
    }
    this.#evictOverflow();
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
}

function immutablePreview(value: LoadedPreviewSvg): LoadedPreviewSvg {
  Object.freeze(value.contentIdentity);
  return Object.freeze(value);
}

function requirePreviewIdentity(
  value: InkbookDocumentRecognition,
  identity: PreviewContentIdentity,
): LoadedPreviewSvg {
  if (value === false || !samePreviewContentIdentity(value.contentIdentity, identity))
    throw new Error("The Inkbook preview source changed while loading.");
  return value;
}
