import type {
  PersistedDocumentIdentity,
  SessionOperationIdentity,
  UnlockResult,
} from "../../../editor/session/session-port";
import type { DocumentRuntimePort } from "../../../persistence/worker/runtime/public";
import {
  loadVaultDocumentWithExecutorRecovery,
  type LoadedVaultDocument,
  type VaultExecutorReplacementOutcome,
} from "./vault-document-loader";
import type { TrustedVaultDocumentRejection } from "./trusted-vault-document-loader";
import {
  samePersistedDocumentIdentity,
  sourceChangedUnlockResult,
} from "./vault-document-session-identity";

interface TrustedUnlockOptions {
  readonly cancelled: () => boolean;
  readonly consumeCancellation: () => boolean;
  readonly createFallback: (workerEpoch: number) => DocumentRuntimePort;
  readonly createReplacement?: (epoch: number) => Promise<VaultExecutorReplacementOutcome>;
  readonly executor: DocumentRuntimePort;
  readonly fallbackUsed: boolean;
  readonly load: (
    executor: DocumentRuntimePort,
    workerEpoch: number,
    policy: {
      readonly acceptExternalVersion?: PersistedDocumentIdentity;
      readonly onRejected: (rejection: TrustedVaultDocumentRejection) => void;
    },
  ) => Promise<LoadedVaultDocument | undefined>;
  readonly operation: SessionOperationIdentity;
  readonly pendingExternalVersion?: PersistedDocumentIdentity | undefined;
  readonly workerEpoch: number;
}

export type TrustedUnlockOutcome =
  | {
      readonly executor: DocumentRuntimePort;
      readonly fallbackUsed: boolean;
      readonly loaded: LoadedVaultDocument;
      readonly status: "loaded";
      readonly workerEpoch: number;
    }
  | {
      readonly executor: DocumentRuntimePort;
      readonly pendingExternalVersion?: PersistedDocumentIdentity | undefined;
      readonly result: UnlockResult;
      readonly status: "rejected";
    };

export async function loadTrustedDocumentForUnlock(
  options: TrustedUnlockOptions,
): Promise<TrustedUnlockOutcome> {
  let trustRejection: TrustedVaultDocumentRejection | undefined;
  const acceptedExternalVersion = samePersistedDocumentIdentity(
    options.operation.expectedSourceIdentity,
    options.pendingExternalVersion,
  )
    ? options.pendingExternalVersion
    : undefined;
  const recovered = await loadVaultDocumentWithExecutorRecovery({
    cancelled: options.cancelled,
    createFallback: options.createFallback,
    ...(options.createReplacement === undefined
      ? {}
      : { createReplacement: options.createReplacement }),
    executor: options.executor,
    fallbackUsed: options.fallbackUsed,
    load: (executor, workerEpoch) =>
      options.load(executor, workerEpoch, {
        ...(acceptedExternalVersion === undefined
          ? {}
          : { acceptExternalVersion: acceptedExternalVersion }),
        onRejected: (rejection) => {
          trustRejection = rejection;
        },
      }),
    workerEpoch: options.workerEpoch,
  });
  const loaded = recovered.loaded;
  if (loaded === undefined || options.consumeCancellation()) {
    recovered.executor.terminate();
    if (trustRejection?.status === "external-version") {
      return {
        executor: recovered.executor,
        pendingExternalVersion: trustRejection.observed,
        result: {
          ...options.operation,
          actualSourceIdentity: {
            outputHash: trustRejection.observed.outputHash,
            revision: trustRejection.observed.revision,
          },
          status: "source-changed",
        },
        status: "rejected",
      };
    }
    return {
      executor: recovered.executor,
      pendingExternalVersion: options.pendingExternalVersion,
      result: { ...options.operation, status: "load-error" },
      status: "rejected",
    };
  }
  const sourceChanged = sourceChangedUnlockResult(options.operation, loaded);
  if (sourceChanged !== undefined) {
    recovered.executor.terminate();
    return { executor: recovered.executor, result: sourceChanged, status: "rejected" };
  }
  return { ...recovered, loaded, status: "loaded" };
}
