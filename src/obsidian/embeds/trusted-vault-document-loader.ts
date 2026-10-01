import type { VaultDocumentSessionHooks } from "./vault-document-recovery";
import { loadVaultDocument, type LoadedVaultDocument } from "./vault-document-loader";
import type { PersistedDocumentIdentity } from "../../editor/session/session-port";
import type { SessionOperationIdentity } from "../../editor/session/session-port";
import type { DocumentRuntimePort } from "../../persistence/worker/runtime/public";
import type {
  TrustedDocumentHead,
  TrustedDocumentHeadPort,
  TrustedDocumentHeadResult,
} from "../storage/trusted-document-head-ledger";

type VaultDocumentLoaderOptions = Parameters<typeof loadVaultDocument>[0];
export type TrustedVaultDocumentRejection = Extract<
  TrustedDocumentHeadResult,
  { readonly status: "external-version" | "storage-error" }
>;

export interface TrustedVaultDocumentLoadPolicy {
  readonly acceptExternalVersion?: "validated-current" | PersistedDocumentIdentity;
  readonly onRejected?: (rejection: TrustedVaultDocumentRejection) => void;
}

export function createTrustedVaultDocumentLoader(options: {
  readonly cancelled: (operation: SessionOperationIdentity) => boolean;
  readonly documentId: string;
  readonly files: VaultDocumentLoaderOptions["files"];
  readonly scheduler: VaultDocumentLoaderOptions["scheduler"];
  readonly hooks: VaultDocumentSessionHooks;
}) {
  return (
    operation: SessionOperationIdentity,
    executor: DocumentRuntimePort,
    purpose: "recovery" | "unlock",
    workerEpoch: number,
    policy: TrustedVaultDocumentLoadPolicy = {},
    prefetchedBytes?: Promise<Uint8Array | undefined>,
  ) =>
    loadTrustedVaultDocument(
      {
        cancelled: () => options.cancelled(operation),
        documentId: options.documentId,
        executor,
        files: options.files,
        operation,
        purpose,
        scheduler: options.scheduler,
        ...(options.hooks.safeStaticProof === undefined
          ? {}
          : {
              safeStaticProof: () => options.hooks.safeStaticProof?.(options.documentId),
            }),
        ...(prefetchedBytes === undefined ? {} : { prefetchedBytes }),
        workerEpoch,
      },
      options.hooks.trustedHeads,
      policy,
    );
}

export async function loadTrustedVaultDocument(
  options: VaultDocumentLoaderOptions,
  trustedHeads: TrustedDocumentHeadPort | undefined,
  policy: TrustedVaultDocumentLoadPolicy = {},
): Promise<LoadedVaultDocument | undefined> {
  const loaded = await loadVaultDocument(options);
  if (loaded === undefined || trustedHeads === undefined) return loaded;
  if (options.cancelled()) return undefined;
  const observed: TrustedDocumentHead = {
    documentId: options.documentId,
    outputHash: loaded.outputHash,
    revision: loaded.snapshot.revision,
  };
  const result = trustedHeads.reconcile(observed);
  if (result.status === "external-version" && acceptsExternalVersion(policy, observed)) {
    const accepted = trustedHeads.acceptExternalVersion(observed);
    if (accepted.status === "accepted") return loaded;
    policy.onRejected?.(accepted);
    return undefined;
  }
  if (result.status === "external-version" || result.status === "storage-error") {
    policy.onRejected?.(result);
    return undefined;
  }
  return loaded;
}

function acceptsExternalVersion(
  policy: TrustedVaultDocumentLoadPolicy,
  observed: TrustedDocumentHead,
): boolean {
  const accepted = policy.acceptExternalVersion;
  return (
    accepted === "validated-current" ||
    (accepted !== undefined &&
      accepted.revision === observed.revision &&
      accepted.outputHash === observed.outputHash)
  );
}
