import type {
  NoteIdentityV1,
  NoteSessionSnapshotV1,
} from "../../application/note-session";
import type {
  PrepareHostEffectRequestV1,
  PrepareHostEffectResultV1,
} from "../../application/host-history/types";
import {
  sidecarStoragePolicyToLayout,
  type FirstSidecarPrepareResultV1,
  type SidecarStoragePolicyV1,
} from "../../application/persistence";
import type { RuntimePersistenceSourceV1 } from "./runtime-persistence-source";
import type {
  RuntimeFirstSidecarV1,
  RuntimeMarkerCheckpointCorrelationV1,
} from "./runtime-first-sidecar";

type FirstSidecarDispatchV1 = Extract<
  PrepareHostEffectResultV1,
  { readonly kind: "prepared" }
>;
type FirstSidecarPreparationV1 =
  FirstSidecarPrepareResultV1<FirstSidecarDispatchV1>;

export function prepareRuntimeFirstSidecarV1(input: {
  readonly correlation: RuntimeMarkerCheckpointCorrelationV1 | null;
  readonly firstSidecar: RuntimeFirstSidecarV1<FirstSidecarDispatchV1> | null;
  readonly request: PrepareHostEffectRequestV1;
  readonly source: RuntimePersistenceSourceV1 | null;
}): Promise<FirstSidecarPreparationV1> {
  const { correlation, firstSidecar, source } = input;
  if (source === null || correlation === null || firstSidecar === null) {
    return Promise.resolve({ kind: "rejected" });
  }
  if (!source.beginObservedMarker(correlation)) {
    return Promise.resolve({ kind: "rejected" });
  }
  const preparation = firstSidecar.prepare(input.request);
  void preparation.then((result) => {
    if (result.kind === "rejected" || result.kind === "drift")
      source.cancelObservedMarker(correlation);
  });
  return preparation;
}

export function createRuntimeMarkerCorrelationV1(input: {
  readonly base: { readonly vaultRelativePath: string } | null;
  readonly identity: NoteIdentityV1;
  readonly request: PrepareHostEffectRequestV1;
  readonly settingsRevision: import("../../application/note-session").SettingsRevision;
  readonly source: NoteSessionSnapshotV1["source"] | undefined;
  readonly storagePolicy: SidecarStoragePolicyV1;
  readonly normalizePath: (path: string) => string;
}): RuntimeMarkerCheckpointCorrelationV1 | null {
  if (input.base === null || input.source?.kind !== "durable") return null;
  return Object.freeze({
    command: Object.freeze({
      expectedSettingsRevision: input.settingsRevision,
      expectedVaultRelativePath: input.base.vaultRelativePath,
      historyEntryId: input.request.historyEntry.historyEntryId,
      noteIdentity: Object.freeze({ ...input.identity }),
      operationId: input.request.operationId,
      storageLayout: sidecarStoragePolicyToLayout(input.storagePolicy, {
        normalizePath: input.normalizePath,
      }),
    }),
    priorSourceDigest: input.source.digest,
    priorSourceGeneration: input.source.generation,
  });
}
