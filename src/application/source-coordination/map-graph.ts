import { commandFailure, commandSuccess } from "../note-session/results";
import type {
  CommandResultV1,
  Sha256Digest,
  SourceGeneration,
} from "../note-session/types";
import {
  composeSourceOffsetMaps,
  encodedSourceOffsetMapBytes,
  identifySourceOffsetMap,
} from "./offset-map";
import { SOURCE_COORDINATION_LIMITS_V1 } from "./limits";
import type {
  SourceOffsetMapIdentityV1,
  SourceOffsetMapV1,
  SourceSnapshotV1,
  StreamingSha256PortV1,
} from "./types";
import type {
  NormalizedSourceMapCompositionRequestV1,
  SourceMapCompositionRequestV1,
  SourceMapCompositionSegmentV1,
} from "./work-ports";

const COMPACTION_INPUT_AND_OUTPUT = 2;

export interface SourceMapGraphNodeV1 {
  readonly depth: number;
  readonly digest: Sha256Digest;
  readonly generation: SourceGeneration;
  readonly mapFromParent: SourceOffsetMapIdentityV1 | null;
  readonly parent: SourceMapGraphNodeV1 | null;
  readonly retainedBytes: number;
  readonly snapshot: SourceSnapshotV1;
}

export interface SourceMapPathV1 {
  readonly offsetMap: SourceOffsetMapV1;
  readonly prior: SourceMapGraphNodeV1;
  readonly replacement: SourceMapGraphNodeV1;
  readonly visitedNodes: number;
}

export function sourceCoordinationRetainedBytes(
  roots: readonly SourceMapGraphNodeV1[],
  additionalMaps: readonly SourceOffsetMapIdentityV1[] = [],
): number {
  const nodes = new Set<SourceMapGraphNodeV1>();
  const maps = new Set<SourceOffsetMapIdentityV1>(additionalMaps);
  const snapshots = new Set<SourceSnapshotV1>();
  const pending = [...roots];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined || nodes.has(node)) continue;
    nodes.add(node);
    snapshots.add(node.snapshot);
    if (node.mapFromParent !== null) maps.add(node.mapFromParent);
    if (node.parent !== null) pending.push(node.parent);
  }
  let retainedBytes = 0;
  for (const snapshot of snapshots) retainedBytes += snapshot.retainedBytes;
  for (const map of maps) retainedBytes += map.encodedBytes;
  return retainedBytes;
}

export function sourceMapGraphNeedsCompaction(
  parent: SourceMapGraphNodeV1,
  projectedRetainedBytes: number,
): boolean {
  return (
    parent.depth >= SOURCE_COORDINATION_LIMITS_V1.maxHistoryMappingNodes ||
    projectedRetainedBytes >
      SOURCE_COORDINATION_LIMITS_V1.maxRetainedSourceBytes
  );
}

export function createSourceMapGraphRoot(
  generation: SourceGeneration,
  digest: Sha256Digest,
  snapshot: SourceSnapshotV1,
): CommandResultV1<SourceMapGraphNodeV1> {
  if (
    snapshot.retainedBytes >
    SOURCE_COORDINATION_LIMITS_V1.maxRetainedSourceBytes
  ) {
    return commandFailure("resource-limit");
  }
  return commandSuccess(
    Object.freeze({
      depth: 0,
      digest,
      generation,
      mapFromParent: null,
      parent: null,
      retainedBytes: snapshot.retainedBytes,
      snapshot,
    }),
  );
}

export function appendSourceMapGraphNode(
  parent: SourceMapGraphNodeV1,
  generation: SourceGeneration,
  digest: Sha256Digest,
  snapshot: SourceSnapshotV1,
  mapFromParent: SourceOffsetMapIdentityV1,
): CommandResultV1<SourceMapGraphNodeV1> {
  if (
    generation !== parent.generation + 1 ||
    mapFromParent.priorUtf16Length !== parent.snapshot.utf16Length ||
    mapFromParent.replacementUtf16Length !== snapshot.utf16Length
  ) {
    return commandFailure("stale-source");
  }
  const retainedBytes =
    parent.retainedBytes + snapshot.retainedBytes + mapFromParent.encodedBytes;
  if (retainedBytes > SOURCE_COORDINATION_LIMITS_V1.maxRetainedSourceBytes) {
    return commandFailure("resource-limit");
  }
  return commandSuccess(
    Object.freeze({
      depth: parent.depth + 1,
      digest,
      generation,
      mapFromParent,
      parent,
      retainedBytes,
      snapshot,
    }),
  );
}

export function materializeSourceMapPath(
  prior: SourceMapGraphNodeV1,
  replacement: SourceMapGraphNodeV1,
): CommandResultV1<SourceMapPathV1> {
  if (prior === replacement) {
    return commandSuccess(
      Object.freeze({
        offsetMap: Object.freeze({ spans: Object.freeze([]) }),
        prior,
        replacement,
        visitedNodes: 0,
      }),
    );
  }
  const maps = collectPathMaps(prior, replacement);
  if (!maps.ok) return maps;
  const composed = composeMapSegments(maps.value);
  if (!composed.ok) return composed;
  return commandSuccess(
    Object.freeze({
      offsetMap: composed.value,
      prior,
      replacement,
      visitedNodes: maps.value.length,
    }),
  );
}

export function createSourceMapCompositionRequest(
  prior: SourceMapGraphNodeV1,
  replacement: SourceMapGraphNodeV1,
): CommandResultV1<NormalizedSourceMapCompositionRequestV1> {
  const maps = collectPathMaps(prior, replacement);
  if (!maps.ok) return maps;
  const segments: SourceMapCompositionSegmentV1[] = maps.value.map((identity) =>
    Object.freeze({
      offsetMap: identity.offsetMap,
      priorUtf16Length: identity.priorUtf16Length,
      replacementUtf16Length: identity.replacementUtf16Length,
    }),
  );
  return createSourceMapCompositionRequestFromSegments(segments);
}

export function createSourceMapCompositionRequestFromSegments(
  segments: readonly SourceMapCompositionSegmentV1[],
): CommandResultV1<NormalizedSourceMapCompositionRequestV1> {
  if (
    segments.length === 0 ||
    segments.length > SOURCE_COORDINATION_LIMITS_V1.maxHistoryMappingNodes
  ) {
    return commandFailure("resource-limit");
  }
  for (let index = 1; index < segments.length; index += 1) {
    if (
      segments[index - 1]?.replacementUtf16Length !==
      segments[index]?.priorUtf16Length
    ) {
      return commandFailure("stale-source");
    }
  }
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (first === undefined || last === undefined) {
    return commandFailure("invalid-command");
  }
  const normalizedSegments = segments.map((segment) =>
    Object.freeze({
      offsetMap: segment.offsetMap,
      priorUtf16Length: segment.priorUtf16Length,
      replacementUtf16Length: segment.replacementUtf16Length,
    }),
  );
  const request = Object.freeze({
    priorUtf16Length: first.priorUtf16Length,
    replacementUtf16Length: last.replacementUtf16Length,
    scratchByteLimit:
      SOURCE_COORDINATION_LIMITS_V1.maxMappingCompactionScratchBytes,
    segments: Object.freeze(normalizedSegments),
    wireVersion: 1 as const,
  });
  return commandSuccess(request as NormalizedSourceMapCompositionRequestV1);
}

export function composeSourceMapCompositionRequest(
  request: SourceMapCompositionRequestV1,
): CommandResultV1<SourceOffsetMapV1> {
  return composeMapSegments(request.segments);
}

export async function compactSourceMapPath(
  port: StreamingSha256PortV1,
  prior: SourceMapGraphNodeV1,
  replacement: SourceMapGraphNodeV1,
): Promise<CommandResultV1<SourceMapGraphNodeV1>> {
  const request = createSourceMapCompositionRequest(prior, replacement);
  if (!request.ok) return request;
  const composed = composeSourceMapCompositionRequest(request.value);
  if (!composed.ok) return composed;
  const encodedBytes = encodedSourceOffsetMapBytes(
    composed.value,
    prior.snapshot.utf16Length,
    replacement.snapshot.utf16Length,
  );
  const scratchBytes = encodedBytes * COMPACTION_INPUT_AND_OUTPUT;
  if (
    scratchBytes >
    SOURCE_COORDINATION_LIMITS_V1.maxMappingCompactionScratchBytes
  ) {
    return commandFailure("resource-limit");
  }
  const identity = await identifySourceOffsetMap(
    port,
    composed.value,
    prior.snapshot.utf16Length,
    replacement.snapshot.utf16Length,
  );
  if (!identity.ok) return identity;
  return createCompactedSourceMapNode(prior, replacement, identity.value);
}

export function createCompactedSourceMapNode(
  prior: SourceMapGraphNodeV1,
  replacement: SourceMapGraphNodeV1,
  identity: SourceOffsetMapIdentityV1,
): CommandResultV1<SourceMapGraphNodeV1> {
  if (
    replacement.generation <= prior.generation ||
    identity.priorUtf16Length !== prior.snapshot.utf16Length ||
    identity.replacementUtf16Length !== replacement.snapshot.utf16Length
  ) {
    return commandFailure("stale-source");
  }
  const retainedBytes =
    prior.retainedBytes +
    replacement.snapshot.retainedBytes +
    identity.encodedBytes;
  if (retainedBytes > SOURCE_COORDINATION_LIMITS_V1.maxRetainedSourceBytes) {
    return commandFailure("resource-limit");
  }
  return commandSuccess(
    Object.freeze({
      depth: prior.depth + 1,
      digest: replacement.digest,
      generation: replacement.generation,
      mapFromParent: identity,
      parent: prior,
      retainedBytes,
      snapshot: replacement.snapshot,
    }),
  );
}

function collectPathMaps(
  prior: SourceMapGraphNodeV1,
  replacement: SourceMapGraphNodeV1,
): CommandResultV1<readonly SourceOffsetMapIdentityV1[]> {
  const maps: SourceOffsetMapIdentityV1[] = [];
  let cursor: SourceMapGraphNodeV1 | null = replacement;
  while (cursor !== null && cursor !== prior) {
    if (maps.length >= SOURCE_COORDINATION_LIMITS_V1.maxHistoryMappingNodes) {
      return commandFailure("resource-limit");
    }
    if (cursor.mapFromParent === null) return commandFailure("stale-source");
    maps.push(cursor.mapFromParent);
    cursor = cursor.parent;
  }
  if (cursor !== prior) return commandFailure("stale-source");
  maps.reverse();
  return commandSuccess(Object.freeze(maps));
}

function composeMapSegments(
  segments: readonly SourceMapCompositionSegmentV1[],
): CommandResultV1<SourceOffsetMapV1> {
  const first = segments[0];
  if (first === undefined) {
    return commandSuccess(Object.freeze({ spans: Object.freeze([]) }));
  }
  let current = first.offsetMap;
  const priorLength = first.priorUtf16Length;
  let replacementLength = first.replacementUtf16Length;
  for (let index = 1; index < segments.length; index += 1) {
    const next = segments[index];
    if (next?.priorUtf16Length !== replacementLength) {
      return commandFailure("stale-source");
    }
    const composed = composeSourceOffsetMaps(
      current,
      next.offsetMap,
      priorLength,
      replacementLength,
      next.replacementUtf16Length,
    );
    if (!composed.ok) return composed;
    current = composed.value;
    replacementLength = next.replacementUtf16Length;
  }
  return commandSuccess(current);
}
