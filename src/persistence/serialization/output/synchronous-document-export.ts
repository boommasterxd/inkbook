import type { InkElementV1, InkSnapshotV1 } from "../../../domain/schema/public";
import type { BackgroundFragmentCache } from "./background";
import type { ElementFragments, RenderBand } from "./element-fragments";
import { prepareSerialization } from "./serialization-budgets";
import { assembleOrderedElementFragments } from "./ordered-element-fragments";
import {
  canonicalMetadataFragmentsSha256,
  metadataPrefix as canonicalMetadataPrefix,
} from "../metadata/canonical-metadata";
import type { DocumentHashPort } from "../sha256";
import type { DocumentCodecResult, SerializedInkbookDocument } from "../types";
import * as document from "./document-assembly";

interface SynchronousExportOptions {
  readonly snapshot: InkSnapshotV1 | null;
  readonly maximumBottom: number | null;
  readonly backgroundCache: BackgroundFragmentCache;
  readonly orders: Record<RenderBand, string[]>;
  readonly element: (id: string) => InkElementV1;
  readonly fragment: (element: InkElementV1) => ElementFragments;
  readonly hasher: DocumentHashPort;
}

export function serializeDocumentFragments(
  options: SynchronousExportOptions,
): DocumentCodecResult<SerializedInkbookDocument> {
  const currentSnapshot = options.snapshot;
  const prepared = prepareSerialization(
    options.snapshot?.page ?? null,
    options.snapshot?.revision ?? null,
    options.maximumBottom,
    options.backgroundCache,
    currentSnapshot ?? undefined,
  );
  if (!prepared.ok) return prepared;
  const {
    background,
    lockedHeight,
    output: outputBudget,
    metadata: metadataBudget,
    page,
    revision,
  } = prepared.value;
  const assembly = assembleOrderedElementFragments({
    orders: options.orders,
    element: (id) => options.element(id),
    fragment: (element) => options.fragment(element),
    outputBudget,
    metadataBudget,
  });
  if (!assembly.ok) return assembly;
  const snapshot = document.snapshotValue(
    revision,
    page,
    assembly.value.elements,
    currentSnapshot?.fontResources,
  );
  const metadata = document.snapshotMetadata(revision, page, assembly.value.metadata, snapshot);
  const metadataHash = canonicalMetadataFragmentsSha256(
    canonicalMetadataPrefix(revision, page, snapshot),
    assembly.value.canonicalMetadata,
  );
  const svg = document.envelope(
    revision,
    lockedHeight,
    { hash: metadataHash, text: metadata, snapshot },
    background,
    assembly.value.highlights,
    assembly.value.content,
  );
  const metadataBytes = metadataBudget.usedBytes;
  const totalBytes = outputBudget.usedBytes;
  return {
    ok: true,
    value: {
      hash: options.hasher.hash(svg),
      lockedHeight,
      metadataBytes,
      snapshot,
      snapshotHash: metadataHash,
      svg,
      totalBytes,
    },
  };
}
