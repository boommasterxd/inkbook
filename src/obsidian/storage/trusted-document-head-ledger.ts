import { sha256Hex } from "../../persistence/serialization/sha256";

export const TRUSTED_DOCUMENT_HEADS_STORAGE_KEY = "inkbook:trusted-document-heads:v1";
export const MAXIMUM_TRUSTED_DOCUMENT_HEADS = 128;

const MAXIMUM_DOCUMENT_ID_LENGTH = 4_096;
const HASH_PATTERN = /^[\da-f]{64}$/u;

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

type StorageError = Extract<TrustedDocumentHeadResult, { readonly status: "storage-error" }>;

export interface TrustedDocumentHeadPort {
  ready(): StorageError | undefined | Promise<StorageError | undefined>;
  acceptExternalVersion(head: TrustedDocumentHead): TrustedDocumentHeadAcceptanceResult;
  recordConfirmed(head: TrustedDocumentHead): TrustedDocumentHeadResult;
  reconcile(head: TrustedDocumentHead): TrustedDocumentHeadResult;
}

interface StoredTrustedDocumentHeadsV1 {
  readonly heads: readonly TrustedDocumentHead[];
  readonly version: 1;
}

interface StoredTrustedDocumentHead extends Omit<TrustedDocumentHead, "documentId"> {
  readonly documentKey: string;
}

interface StoredTrustedDocumentHeadsV2 {
  readonly heads: readonly StoredTrustedDocumentHead[];
  readonly version: 2;
}

type LoadedHeads = StoredTrustedDocumentHeadsV1 | StoredTrustedDocumentHeadsV2 | StorageError;

/**
 * Reconciles independently validated SVG identities with a bounded device-local history.
 * Session code must treat every non-trusted result as a recovery state before adopting a model.
 */
export class TrustedDocumentHeadLedger {
  #loaded: LoadedHeads;
  #migration: Promise<StorageError | undefined> | undefined;

  public constructor(
    private readonly storage: DeviceLocalStoragePort,
    private readonly checkpoint: () => Promise<void> | undefined = () => undefined,
  ) {
    this.#loaded = loadHeads(storage) ?? { heads: [], version: 2 };
  }

  public ready(): StorageError | undefined | Promise<StorageError | undefined> {
    const loaded = this.#loaded;
    if ("status" in loaded) return loaded;
    if (loaded.version === 2) return undefined;
    this.#migration ??= this.#migrate(loaded).finally(() => {
      this.#migration = undefined;
    });
    return this.#migration;
  }

  public reconcile(observed: TrustedDocumentHead): TrustedDocumentHeadResult {
    return this.#reconcile(observed, false);
  }

  #reconcile(observed: TrustedDocumentHead, confirm: boolean): TrustedDocumentHeadResult {
    const prepared = this.#prepare(observed);
    if ("status" in prepared) return prepared;
    observed = copyHead(observed);
    const stored = prepared.heads.find((head) => head.documentKey === prepared.next.documentKey);
    if (stored === undefined) return this.#persist(prepared, observed, "created");
    const trusted = {
      documentId: observed.documentId,
      outputHash: stored.outputHash,
      revision: stored.revision,
    };
    if (observed.revision < trusted.revision) {
      return { observed, reason: "lower-revision", status: "external-version", trusted };
    }
    if (observed.revision === trusted.revision) {
      if (observed.outputHash === trusted.outputHash) return { head: trusted, status: "unchanged" };
      if (confirm) return this.#persist(prepared, observed, "confirmed");
      return {
        observed,
        reason: "same-revision-different-hash",
        status: "external-version",
        trusted,
      };
    }
    return this.#persist(prepared, observed, "advanced");
  }

  public acceptExternalVersion(observed: TrustedDocumentHead): TrustedDocumentHeadAcceptanceResult {
    const prepared = this.#prepare(observed);
    return "status" in prepared
      ? prepared
      : this.#persist(prepared, copyHead(observed), "accepted");
  }

  public recordConfirmed(observed: TrustedDocumentHead): TrustedDocumentHeadResult {
    return this.#reconcile(observed, true);
  }

  #prepare(observed: TrustedDocumentHead): PreparedHead | StorageError {
    if (!isTrustedHead(observed)) return storageError("validate");
    if ("status" in this.#loaded) return this.#loaded;
    if (this.#loaded.version !== 2) return storageError("load");
    return { heads: this.#loaded.heads, next: storedHead(observed) };
  }

  #persist(
    prepared: PreparedHead,
    head: TrustedDocumentHead,
    status: "accepted",
  ): TrustedDocumentHeadAcceptanceResult;
  #persist(
    prepared: PreparedHead,
    head: TrustedDocumentHead,
    status: "advanced" | "confirmed" | "created",
  ): TrustedDocumentHeadResult;
  #persist(
    prepared: PreparedHead,
    head: TrustedDocumentHead,
    status: "accepted" | "advanced" | "confirmed" | "created",
  ): TrustedDocumentHeadAcceptanceResult | TrustedDocumentHeadResult {
    const retained = prepared.heads.filter(
      (candidate) => candidate.documentKey !== prepared.next.documentKey,
    );
    const heads = [...retained, prepared.next].slice(-MAXIMUM_TRUSTED_DOCUMENT_HEADS);
    return this.#save(heads) ?? { head, status };
  }

  async #migrate(legacy: StoredTrustedDocumentHeadsV1): Promise<StorageError | undefined> {
    const heads: StoredTrustedDocumentHead[] = [];
    try {
      for (const head of legacy.heads) {
        const pending = this.checkpoint();
        if (pending !== undefined) await pending;
        heads.push(storedHead(head));
      }
      const pending = this.checkpoint();
      if (pending !== undefined) await pending;
    } catch {
      return storageError("load");
    }
    const latest = loadHeads(this.storage);
    if (latest === null) return storageError("load");
    if ("status" in latest) return latest;
    if (latest.version === 2) {
      if (latest.heads.length === 0 && legacy.heads.length > 0) return storageError("load");
      this.#loaded = latest;
      return undefined;
    }
    if (!sameHeads(legacy.heads, latest.heads, (head) => head.documentId)) {
      this.#loaded = latest;
      return storageError("load");
    }
    return this.#save(heads);
  }

  #save(heads: readonly StoredTrustedDocumentHead[]): StorageError | undefined {
    const value: StoredTrustedDocumentHeadsV2 = { heads, version: 2 };
    try {
      this.storage.saveLocalStorage(TRUSTED_DOCUMENT_HEADS_STORAGE_KEY, value);
    } catch {
      return storageError("save");
    }
    // Obsidian can swallow local storage write failures. Trust only the confirmed payload.
    const confirmed = loadHeads(this.storage);
    if (
      confirmed === null ||
      "status" in confirmed ||
      confirmed.version !== 2 ||
      !sameHeads(heads, confirmed.heads, (head) => head.documentKey)
    )
      return storageError("save");
    this.#loaded = confirmed;
    return undefined;
  }
}

interface PreparedHead {
  readonly heads: readonly StoredTrustedDocumentHead[];
  readonly next: StoredTrustedDocumentHead;
}

function loadHeads(storage: DeviceLocalStoragePort): LoadedHeads | null {
  let stored: unknown;
  try {
    stored = storage.loadLocalStorage(TRUSTED_DOCUMENT_HEADS_STORAGE_KEY);
  } catch {
    return storageError("load");
  }
  if (stored === null || stored === undefined) return null;
  if (
    !isRecord(stored) ||
    !Array.isArray(stored.heads) ||
    stored.heads.length > MAXIMUM_TRUSTED_DOCUMENT_HEADS
  )
    return storageError("validate");
  const heads: readonly unknown[] = stored.heads;
  if (stored.version === 1 && uniqueHeads(heads, isTrustedHead, (head) => head.documentId))
    return { heads: heads.map(copyHead), version: 1 };
  if (
    stored.version === 2 &&
    Object.keys(stored).length === 2 &&
    uniqueHeads(heads, isStoredHead, (head) => head.documentKey)
  )
    return {
      heads: heads.map(({ documentKey, outputHash, revision }) => ({
        documentKey,
        outputHash,
        revision,
      })),
      version: 2,
    };
  return storageError("validate");
}

function copyHead(head: TrustedDocumentHead): TrustedDocumentHead {
  return { documentId: head.documentId, outputHash: head.outputHash, revision: head.revision };
}

function storedHead(head: TrustedDocumentHead): StoredTrustedDocumentHead {
  return {
    documentKey: sha256Hex(JSON.stringify(["inkbook:trusted-document-path:v1", head.documentId])),
    outputHash: head.outputHash,
    revision: head.revision,
  };
}

function sameHeads<Head extends Pick<TrustedDocumentHead, "outputHash" | "revision">>(
  expected: readonly Head[],
  actual: readonly Head[],
  keyOf: (head: Head) => string,
): boolean {
  return (
    expected.length === actual.length &&
    expected.every((head, index) => {
      const next = actual[index]!;
      return (
        keyOf(head) === keyOf(next) &&
        head.outputHash === next.outputHash &&
        head.revision === next.revision
      );
    })
  );
}

function storageError(operation: StorageError["operation"]): StorageError {
  return { operation, status: "storage-error" };
}

function uniqueHeads<Head>(
  values: readonly unknown[],
  validate: (value: unknown) => value is Head,
  keyOf: (head: Head) => string,
): values is readonly Head[] {
  const keys = new Set<string>();
  for (const head of values) {
    if (!validate(head)) return false;
    const key = keyOf(head);
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

function isTrustedHead(value: unknown): value is TrustedDocumentHead {
  return (
    isRecord(value) &&
    typeof value.documentId === "string" &&
    value.documentId.length > 0 &&
    value.documentId.length <= MAXIMUM_DOCUMENT_ID_LENGTH &&
    hasHeadIdentity(value)
  );
}

function isStoredHead(value: unknown): value is StoredTrustedDocumentHead {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    typeof value.documentKey === "string" &&
    HASH_PATTERN.test(value.documentKey) &&
    hasHeadIdentity(value)
  );
}

function hasHeadIdentity(value: Record<string, unknown>): boolean {
  return (
    typeof value.outputHash === "string" &&
    HASH_PATTERN.test(value.outputHash) &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
