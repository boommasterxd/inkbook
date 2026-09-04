export const TRUSTED_DOCUMENT_HEADS_STORAGE_KEY = "inkbook:trusted-document-heads:v1";
export const MAXIMUM_TRUSTED_DOCUMENT_HEADS = 128;

const MAXIMUM_DOCUMENT_ID_LENGTH = 4_096;
const OUTPUT_HASH_PATTERN = /^[\da-f]{64}$/u;

export interface DeviceLocalStoragePort {
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, data: unknown): void;
}

export interface TrustedDocumentHead {
  readonly documentId: string;
  readonly outputHash: string;
  readonly revision: number;
}

export type TrustedDocumentHeadResult =
  | {
      readonly head: TrustedDocumentHead;
      readonly status: "advanced" | "confirmed" | "created" | "unchanged";
    }
  | {
      readonly observed: TrustedDocumentHead;
      readonly reason: "lower-revision" | "same-revision-different-hash";
      readonly status: "external-version";
      readonly trusted: TrustedDocumentHead;
    }
  | {
      readonly operation: "load" | "save" | "validate";
      readonly status: "storage-error";
    };

export type TrustedDocumentHeadAcceptanceResult =
  | {
      readonly head: TrustedDocumentHead;
      readonly status: "accepted";
    }
  | Extract<TrustedDocumentHeadResult, { readonly status: "storage-error" }>;

export interface TrustedDocumentHeadPort {
  acceptExternalVersion(head: TrustedDocumentHead): TrustedDocumentHeadAcceptanceResult;
  recordConfirmed(head: TrustedDocumentHead): TrustedDocumentHeadResult;
  reconcile(head: TrustedDocumentHead): TrustedDocumentHeadResult;
}

interface StoredTrustedDocumentHeadsV1 {
  readonly heads: readonly TrustedDocumentHead[];
  readonly version: 1;
}

/**
 * Reconciles independently validated SVG identities with a bounded device-local history.
 * Session code must treat every non-trusted result as a recovery state before adopting a model.
 */
export class TrustedDocumentHeadLedger {
  readonly #initial: LoadedHeads;
  readonly #storage: DeviceLocalStoragePort;
  #heads: readonly TrustedDocumentHead[];

  public constructor(storage: DeviceLocalStoragePort) {
    this.#storage = storage;
    this.#initial = loadHeads(storage);
    this.#heads = this.#initial.heads;
  }

  public reconcile(observed: TrustedDocumentHead): TrustedDocumentHeadResult {
    const prepared = this.#prepare(observed);
    if ("status" in prepared) return prepared;
    observed = prepared;
    const trusted = this.#heads.find((head) => head.documentId === observed.documentId);
    if (trusted === undefined) return this.#persist(observed, "created");
    if (observed.revision < trusted.revision) {
      return { observed, reason: "lower-revision", status: "external-version", trusted };
    }
    if (observed.revision === trusted.revision) {
      return observed.outputHash === trusted.outputHash
        ? { head: trusted, status: "unchanged" }
        : {
            observed,
            reason: "same-revision-different-hash",
            status: "external-version",
            trusted,
          };
    }
    return this.#persist(observed, "advanced");
  }

  public acceptExternalVersion(observed: TrustedDocumentHead): TrustedDocumentHeadAcceptanceResult {
    const prepared = this.#prepare(observed);
    return "status" in prepared ? prepared : this.#persist(prepared, "accepted");
  }

  public recordConfirmed(observed: TrustedDocumentHead): TrustedDocumentHeadResult {
    const result = this.reconcile(observed);
    return result.status === "external-version" && result.reason === "same-revision-different-hash"
      ? this.#persist(observed, "confirmed")
      : result;
  }

  #prepare(
    observed: TrustedDocumentHead,
  ):
    TrustedDocumentHead | Extract<TrustedDocumentHeadResult, { readonly status: "storage-error" }> {
    if (!isTrustedHead(observed)) return { operation: "validate", status: "storage-error" };
    if (this.#initial.error !== undefined) {
      return { operation: this.#initial.error, status: "storage-error" };
    }
    return copyHead(observed);
  }

  #persist(head: TrustedDocumentHead, status: "accepted"): TrustedDocumentHeadAcceptanceResult;
  #persist(
    head: TrustedDocumentHead,
    status: "advanced" | "confirmed" | "created",
  ): TrustedDocumentHeadResult;
  #persist(
    head: TrustedDocumentHead,
    status: "accepted" | "advanced" | "confirmed" | "created",
  ): TrustedDocumentHeadAcceptanceResult | TrustedDocumentHeadResult {
    const retained = this.#heads.filter((candidate) => candidate.documentId !== head.documentId);
    const heads = [...retained, head].slice(-MAXIMUM_TRUSTED_DOCUMENT_HEADS);
    try {
      this.#storage.saveLocalStorage(TRUSTED_DOCUMENT_HEADS_STORAGE_KEY, {
        heads,
        version: 1,
      } satisfies StoredTrustedDocumentHeadsV1);
    } catch {
      return { operation: "save", status: "storage-error" };
    }
    this.#heads = heads;
    return { head, status };
  }
}

interface LoadedHeads {
  readonly error?: "load" | "validate";
  readonly heads: readonly TrustedDocumentHead[];
}

function loadHeads(storage: DeviceLocalStoragePort): LoadedHeads {
  let stored: unknown;
  try {
    stored = storage.loadLocalStorage(TRUSTED_DOCUMENT_HEADS_STORAGE_KEY);
  } catch {
    return { error: "load", heads: [] };
  }
  if (stored === null || stored === undefined) return { heads: [] };
  if (!isStoredLedger(stored)) return { error: "validate", heads: [] };
  return { heads: stored.heads.map(copyHead) };
}

function copyHead(head: TrustedDocumentHead): TrustedDocumentHead {
  return { documentId: head.documentId, outputHash: head.outputHash, revision: head.revision };
}

function isStoredLedger(value: unknown): value is StoredTrustedDocumentHeadsV1 {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.heads)) return false;
  if (value.heads.length > MAXIMUM_TRUSTED_DOCUMENT_HEADS) return false;
  const documentIds = new Set<string>();
  for (const head of value.heads) {
    if (!isTrustedHead(head) || documentIds.has(head.documentId)) return false;
    documentIds.add(head.documentId);
  }
  return true;
}

function isTrustedHead(value: unknown): value is TrustedDocumentHead {
  return (
    isRecord(value) &&
    typeof value.documentId === "string" &&
    value.documentId.length > 0 &&
    value.documentId.length <= MAXIMUM_DOCUMENT_ID_LENGTH &&
    typeof value.outputHash === "string" &&
    OUTPUT_HASH_PATTERN.test(value.outputHash) &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
