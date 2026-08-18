# ADR 0001: Clean-Room Implementation

Status: Accepted

## Context

Inkbook is informed by user-visible behavior of an adjacent Obsidian annotation project, but its source, internal names, algorithms, fixtures, assets, and implementation details are not authorized implementation inputs. The product must remain independently implementable from this specification and public Obsidian evidence.

## Decision

Inkbook uses a separated clean-room process:

1. specification work may record user requirements, independently observed behavior, public Obsidian API evidence, and independently derived algorithms;
2. production implementers receive this specification, accepted ADRs, public API documentation, and provenance-approved dependencies, but no source or non-public implementation material from the adjacent project;
3. production code, tests, fixtures, algorithms, icons, SVG paths, names, comments, and assets are created independently;
4. every introduced artifact records its origin in `provenance/clean-room.jsonl` before it is merged;
5. each phase exit verifies the changed provenance records, dependency licenses, and absence of copied reference identifiers or fixtures;
6. public distribution receives a separate factual license and provenance review and does not imply a legal guarantee.

The append-only JSON Lines log uses UTF-8 and one canonical JSON object per line with these fields:

```ts
export interface CleanRoomProvenanceRecordV1 {
  readonly schemaVersion: 1;
  readonly artifactPath: string;
  readonly artifactSha256: string;
  readonly artifactKind:
    | "code"
    | "test"
    | "fixture"
    | "algorithm"
    | "icon"
    | "asset"
    | "configuration"
    | "documentation";
  readonly origin:
    "specification" | "public-api" | "independent-design" | "dependency";
  readonly purpose: string;
  readonly sourceReferences: readonly string[];
  readonly dependencyName: string | null;
  readonly dependencyVersion: string | null;
  readonly dependencyLicense: string | null;
  readonly authorAttestation: string;
  readonly supersedesRecordSha256: string | null;
  readonly reviewedBy: string;
  readonly reviewedAtUtc: string;
}
```

Paths are project-relative, normalized, and unique among live records. `purpose` is non-empty and explains why the artifact or dependency exists. `artifactSha256` is exactly 64 lowercase hexadecimal characters and is SHA-256 over the exact current file bytes. Every artifact-content change appends a superseding record, even when origin and purpose remain unchanged. `supersedesRecordSha256` names the SHA-256 of the exact canonical UTF-8 JSON bytes of the immediate predecessor record without a trailing line feed; an initial record uses null. CI validates exactly one acyclic supersession chain per artifact path, exactly one live tip, and equality between each live tip's `artifactSha256` and the current artifact bytes. `sourceReferences` may contain official URLs, specification paths, or accepted ADR paths, but never a path into the adjacent reference source. The CI checker fails on a missing production artifact, missing required field, digest mismatch, duplicate live tip, broken or cyclic supersession, unknown origin, unreviewed entry, incompatible dependency license, or forbidden reference path.

Behavioral observation and implementation roles may be performed by different contributors or agents, but the implementation role must not inspect or summarize reference source. A contributor who has already read reference source may implement only when the reviewer records a concrete isolation assessment and can prove the artifact from independent requirements or public algorithms. Otherwise another implementer is required.

## Allowed Evidence

- user requirements and corrections;
- this specification and accepted ADRs;
- official Obsidian documentation and public TypeScript declarations;
- public standards and independently selected, license-compatible dependencies;
- black-box behavior observed through ordinary product use without extracting source or proprietary assets;
- independently generated golden fixtures whose derivation is recorded.

## Forbidden Inputs

- copied or translated source, comments, identifiers, tests, fixtures, SVG paths, icons, assets, or build configuration from the adjacent project;
- reconstruction from source-level summaries supplied to the implementation role;
- dependency or asset adoption without recorded version, license, and purpose;
- a late provenance reconstruction after implementation has already been accepted.

## Consequences

The Phase 0 scaffold must create and validate `provenance/clean-room.jsonl` before any product module is added. CI treats provenance as a required per-commit gate. The process adds review work, but it makes the implementation boundary explicit and auditable. This ADR does not grant a license, determine legal compliance, or replace professional legal advice.

## Related Contracts

- [Architecture](../specification/04-architecture.md)
- [Quality and Performance](../specification/09-quality-and-performance.md)
- [References](../specification/13-references.md)
- [Implementation Roadmap](../specification/11-implementation-roadmap.md)
