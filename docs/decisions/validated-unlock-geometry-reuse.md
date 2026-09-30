# Snapshot-Authoritative Unlock and Output Reuse

Status: Accepted; supersedes canonical geometry reconstruction and transferred-path reuse during unlock.

## Context

Unlock previously reconstructed every canonical path to prove that editable metadata and supplied static SVG agreed. Pressure-heavy documents paid for full-document contours before the visible scene could mount. A bounded cross-session path cache avoided this only for unchanged files and transferred additional geometry that the receiver validated again.

## Decision

Editable metadata is authoritative after bounded schema, root revision, original metadata-byte SHA-256, derived bounds, and input-limit validation. Unlock permits safe JSON formatting differences and does not reserialize the complete snapshot to compare canonical metadata spelling. Strict output verification retains canonical metadata comparison. Unlock validates the complete supplied SVG presentation against the safe envelope without reconstructing canonical geometry. The streaming suffix validator uses the same path grammar, paint, group, command, and aggregate limits as preview validation. It retains at most one incomplete tag, capped at the existing 16 MiB path-data maximum plus 4 KiB of attribute allowance, and checkpoints long path validation. It does not join or retain a complete SVG string.

Unlock does not build or transfer prepared pressure paths, and it does not retain a cross-session geometry proof. The active scene derives geometry only from the validated model for visible elements under its existing bounded preparation and cache policy. Input cancellation and terminal validation still prevent publication of an incomplete document. The owned worker handoff checks operation identity, element counts, ordering, and detached Store adoption; it does not serialize every point again on both sides to produce and compare a redundant unlock transport hash. Persisted export integrity manifests remain unchanged.

A safe external presentation may differ from the metadata. Locked preview shows that supplied presentation; unlocking shows the validated snapshot. A later edit and save replaces external presentation changes with canonical output. Unlock alone does not force a rewrite merely because the safe presentation might differ. Unsafe markup, invalid model data, incorrect hashes, and limits remain failures. This deliberately removes static/model equality as an editable-input acceptance condition; it does not relax canonical output verification.

Locked preview and worker unlock currently each inspect the safe presentation. There is no trusted preview-proof handoff. Reusing that proof is a separate optimization requiring complete-byte identity and an explicit host ownership boundary.

## Persisted-Output Verification

The executor separately retains two scalar proof slots for completely verified canonical input and its latest successful canonical export. Safe unlock does not populate either canonical proof slot. Complete strict output verification may seed or advance the input slot; the export slot is populated only after canonical serialization. Neither slot retains complete output or accepts proof supplied by a file or caller.

Autosave preflight separately owns its confirmed persisted base. It hashes newly read bytes and compares both the canonical revision prefix and full hash to that base before asking the executor for verification. An exact match reuses the confirmed base, including a source accepted by safe unlock, without another safe-SVG scan or worker geometry reconstruction. Changed bytes retain strict verification; a hash mismatch adds one preliminary hash pass. No SVG or geometry is retained by this shortcut.

Verification hashes newly read bytes under input limits and cancellation checkpoints. An exact canonical proof match returns the proven revision; a miss performs complete canonical validation. Initialization, clear, and executor replacement invalidate ownership, and epoch checks prevent suspended work from repopulating cleared slots. Host reads, operation identities, conflict checks, writes, and read-back confirmation remain required.

The bundled worker and fallback canonical serializer are internal producers, not external SVG inputs. Receiver adoption checks operation identity, exclusive transferable ownership, byte capacity, fatal UTF-8 decoding, and the bounded canonical root. Export revision and snapshot digest remain bound to the model integrity manifest. Adoption and the internal save entry points do not repeat full SVG allowlist scans or output hashing. The serializer enforces UTF-8 byte capacity for its string fallback; receiver string checks add a cheap length guard. This trusts serializer correctness and browser transport instead of attempting to detect arbitrary internal code defects with repeated production validation.

Actual Vault reads remain external boundaries. Exact read-back comparison covers every persisted character against the owned output; differing content takes the strict verification path. Preflight and the atomic write callback retain external-change conflict checks, and stale revisions cannot be written. No additional output cache or lifetime is introduced. Workspace own-write event suppression and recognition reuse the actual verified readback only while its host-owned file identity, stats, and modification epoch remain current. Missing or stale proofs require a bounded fresh read and complete hash; an unknown identity enters ordinary external-change handling. See the [host persistence contract](../obsidian-integration.md#vault-file-and-link-apis).

An own-export hit trusts the successful canonical serializer. It removes independent second production geometry reconstruction as a way to detect serializer defects. Canonical output parity and regression tests protect that boundary; exact hashing proves that persisted bytes equal the known output.

## Verification Boundaries

Regression coverage must observe zero canonical path construction during cold unlock, accept safe divergent presentation only for unlock, and reject unsafe suffixes, invalid metadata, exceeded limits, and cancellation. Strict verification must reject the same divergent presentation even after successful unlock. Work/resource coverage retains the full representative document and checks batching, visible scene preparation, retained resources, proof replacement, and strict fallback.

These contracts do not establish a latency guarantee or parity with another plugin. Schema and safe-presentation scans, full-file hashing, visible pressure geometry, DOM attachment, and browser painting still have real costs. Physical-device latency remains a separate acceptance requirement.
