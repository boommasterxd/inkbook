import type {
  HostTransactionSequence,
  Sha256Digest,
  ViewId,
} from "../note-session/types";
import type { AdmittedSourceTransitionV1 } from "./checkpoints";
import type { SourceMapGraphNodeV1 } from "./map-graph";
import type { MarkdownSourceTransitionV1, SourceAdmissionV1 } from "./types";

export function sourceViewSequenceState(
  sequences: ReadonlyMap<ViewId, HostTransactionSequence>,
  request: MarkdownSourceTransitionV1,
): "new" | "retry" | null {
  if (
    !Number.isSafeInteger(request.hostTransactionSequence) ||
    request.hostTransactionSequence <= 0
  ) {
    return null;
  }
  const prior = sequences.get(request.viewId);
  if (prior !== undefined && request.hostTransactionSequence < prior) {
    return null;
  }
  return prior === request.hostTransactionSequence ? "retry" : "new";
}

export function recognizeSourceDuplicate(
  prior: AdmittedSourceTransitionV1 | null,
  current: SourceMapGraphNodeV1,
  request: MarkdownSourceTransitionV1,
  replacementDigest: Sha256Digest,
  mapDigest: Sha256Digest,
): SourceAdmissionV1 | null {
  if (
    prior === null ||
    replacementDigest !== current.digest ||
    request.priorGeneration !== prior.priorGeneration ||
    request.priorDigest !== prior.priorDigest ||
    mapDigest !== prior.mapDigest
  ) {
    return null;
  }
  return Object.freeze({
    digest: prior.node.digest,
    generation: prior.node.generation,
    kind: "duplicate",
    mapDigest,
    snapshot: prior.node.snapshot,
  });
}
