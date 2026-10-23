import { derivePageExtent, PAGE_WIDTH } from "../../../domain/geometry/public";
import type { InkSnapshotV1 } from "../../../domain/schema/public";
import type { ElementStore } from "../../../domain/store/public";
import type {
  PersistedDocumentIdentity,
  SessionOperationIdentity,
  UnlockResult,
} from "../../../editor/session/session-port";
import type { LoadedVaultDocument } from "./vault-document-loader";
import { requireVaultPage } from "./vault-document-model";

export function sourceChangedUnlockResult(
  operation: SessionOperationIdentity,
  loaded: LoadedVaultDocument,
): Extract<UnlockResult, { readonly status: "source-changed" }> | undefined {
  const expected = operation.expectedSourceIdentity;
  if (
    expected === undefined ||
    (expected.revision === loaded.snapshot.revision && expected.outputHash === loaded.outputHash)
  ) {
    return undefined;
  }
  return {
    ...operation,
    actualSourceIdentity: {
      outputHash: loaded.outputHash,
      revision: loaded.snapshot.revision,
    },
    status: "source-changed",
  };
}

export function samePersistedDocumentIdentity(
  left: PersistedDocumentIdentity | undefined,
  right: PersistedDocumentIdentity | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.revision === right.revision &&
    left.outputHash === right.outputHash
  );
}

export function lockedDocumentAspectRatio(
  page: InkSnapshotV1["page"] | undefined,
  store: ElementStore,
): number {
  return (
    PAGE_WIDTH /
    derivePageExtent(requireVaultPage(page), store.getMaximumBottom() ?? null).lockedHeight
  );
}
