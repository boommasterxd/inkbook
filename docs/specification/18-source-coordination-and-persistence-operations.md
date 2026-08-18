# Source Coordination and Persistence Operations

This document owns source offset maps, multi-pane source admission, initial-sidecar state, and relocation or removal transition validation. [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md) owns the referenced IDs, operations, recovery attempts, records, and `RecoveryStore`. [Sidecar Persistence](07-sidecar-persistence.md) owns Vault writes and file conflicts.

## 1. Source Offset Maps and Multi-Pane Admission

```ts
export interface SourceOffsetSpanV1 {
  readonly oldFromUtf16: number;
  readonly oldToUtf16: number;
  readonly newFromUtf16: number;
  readonly newToUtf16: number;
}

export interface SourceOffsetMapV1 {
  readonly spans: readonly SourceOffsetSpanV1[];
}

export interface SourceCheckpointOperationV1 {
  readonly checkpointId: SourceCheckpointId;
  readonly sessionOrder: SessionOrder;
  readonly priorGeneration: SourceGeneration;
  readonly replacementGeneration: SourceGeneration;
  readonly priorDigest: Sha256Digest;
  readonly replacementDigest: Sha256Digest;
  readonly priorUtf16Length: number;
  readonly replacementUtf16Length: number;
  readonly offsetMap: SourceOffsetMapV1;
  readonly base: SidecarBaseIdentityV1;
}
```

All offsets and lengths are non-negative safe integers. Each span satisfies `oldFromUtf16 <= oldToUtf16` and `newFromUtf16 <= newToUtf16`. Spans are strictly ordered and non-overlapping in both coordinate systems. The unchanged gap before the first span, between adjacent spans, and after the last span has the same UTF-16 length in both coordinate systems. Empty insertions and deletions are represented by equal endpoints on the applicable side. An equal-length replacement remains a span because its source evidence changed. Adjacent changed spans are merged, so the stored sequence is the unique minimal representation. The empty sequence is the identity map and requires equal prior and replacement lengths.

Unlisted intervals map by the cumulative length delta. A boundary inside a changed span maps to the replacement start or end according to the association rules in [Anchors and Layout](05-anchors-and-layout.md). Composition applies maps in admitted host order, retains the union of changed evidence, merges adjacent output spans, and produces the same canonical sequence regardless of batching. The canonical map digest is SHA-256 over RFC 8785 canonical UTF-8 JSON for `{ priorUtf16Length, replacementUtf16Length, spans }` without a trailing LF. The map contains positions and lengths only, never inserted Markdown.

The `MarkdownSourceCoordinator` admits a candidate by compare-and-swap over current generation and digest. A view submits prior digest, replacement digest, canonical offset-map digest, view identity, and host transaction sequence. If prior digest equals current digest, it is one new transition and receives the next generation. If replacement digest already equals current digest and prior digest plus map digest match the retained admitted transition, it is a duplicate delivery: only that view token advances. It does not remap anchors, append recovery, enqueue save, or advance generation. Every other mismatch enters bounded external-change reattachment.

The coordinator retains only the active transition and last acknowledged transition needed for duplicate recognition. YAML marker transactions use the same admission path and are tagged as owned metadata changes, but their actual source offsets still advance the source generation exactly once.

Recovery validates stored checkpoints as one strictly contiguous chain rooted at the validated sidecar's source generation and Markdown digest. For each next record, prior generation, prior digest, prior UTF-16 length, and sidecar base must match the preceding acknowledged state exactly, and replacement generation must equal prior generation plus one. It merges checkpoints and host-recorded attempts by `SessionOrder`: an attempt replays at its unique matching source node, and its introduced or replaced bindings map through every later validated checkpoint in order. The final selected checkpoint node must match current Markdown digest and UTF-16 length; if current Markdown equals the root, no checkpoint applies. Any gap, fork, duplicate with unequal bytes, ambiguous node, length mismatch, unrelated digest, invalid map, or unsafe patch rebase publishes nothing and enters bounded external-change reattachment or explicit review.

## 2. Initial Sidecar and Save Acknowledgement

Inkbook never writes an observable empty revision-zero sidecar. After marker preflight and durable source checkpoint, the first accepted annotation uses the normal recovery and host-history protocol. The first successful `Vault.create()` writes the canonical scene containing that annotation and the default note appearance effective when the command was admitted, with sidecar `revision: 1`, `baseRevision: null`, scene `revision: 1`, schema `{ major: 1, minor: 0 }`, current durable Markdown identity, source generation, and digest, and selected storage layout.

An `absent-first-sidecar` load requires a base whose revision and raw digest are null, the validated expected path, and current Markdown digest and UTF-16 length. Only the matching `host-recorded-forward` attempt with the same pending identity, path, source evidence, and scene expectations may perform create-if-absent exactly once. A path collision enters conflict. A prepared-only command creates no sidecar. Every later successful save increments sidecar revision by one and writes `baseRevision` equal to the immediately preceding acknowledged sidecar revision. Coalesced scene operations still produce one sidecar revision per acknowledged Vault write.

## 3. Relocation and Removal Records

Relocation and annotation-removal records use the closed records in Section 6 of [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md). Paths are normalized Vault-relative paths and remain subject to the persistence limits. A file-relocation transition preserves every immutable identity and may move only to the immediately following listed step. A prefix relocation preserves its prefixes, generation, admitted count, and settings revision; `cursor` may only increase through `processing`, and `complete` requires `cursor === admittedRecordCount`. Removal transitions preserve identity, base, scene revision, and deadline, change an acknowledgement flag only from false to true, and move marker state only from `present` to `removing` to `removed`. Completion requires the terminal record hash and removes only that exact saga.

Prefix relocation history uses the bounds and deterministic resolution rules in [Sidecar Persistence](07-sidecar-persistence.md). Annotation removal records the expected trash acknowledgement and delete event independently and clears session plus recovery only after the two-signal barrier and YAML-marker removal both succeed.
