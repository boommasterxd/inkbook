# Sidecar Persistence

## 1. Storage Decision

An annotated note uses one Markdown file and one Vault-local sidecar. The default layout is adjacent:

```text
Course Notes.md
Course Notes.inkbook.json
```

The Markdown file remains canonical for text. The resolved sidecar is canonical for plugin-owned annotation elements, bindings, anchors, styles, z-order, note background, and schema metadata.

Sidecar storage uses one validated plugin-global `SidecarStoragePolicyV1`: `adjacent`, or `vault-root` with one non-empty normalized Vault-relative root. The suffix is always `.inkbook.json`. A `vault-root` policy mirrors the Markdown path below that root when a sidecar is first created. For example, `Notes/Course.md` under root `Annotations` resolves to `Annotations/Notes/Course.inkbook.json`. Mirroring prevents same-name notes in different folders from colliding.

Absolute paths, path traversal, backslashes, NUL, empty segments, `.`, `..`, `.obsidian`, hidden path segments, and a path outside the Vault are rejected. Every accepted path passes through Obsidian `normalizePath()` and is resolved through Vault capabilities. Changing the policy affects new sidecars only. An existing note keeps the location recorded by its YAML locator until an explicit migration succeeds.

## 2. YAML Presence Marker

Outside a defined transient drift state, an annotated Markdown note MUST contain this minimal YAML property:

```yaml
---
inkbook-annotations: true
inkbook-sidecar: Course Notes.inkbook.json
---
```

`inkbook-annotations` is a discovery and user-awareness hint. `inkbook-sidecar` is the exact normalized Vault-relative locator selected for that note. The locator is untrusted discovery evidence, not an authorization mechanism. YAML MUST NOT contain annotation data, a revision, geometry, or a sidecar digest. Before load or write, the adapter validates the locator, suffix, file kind, and embedded Markdown identity against the concrete note. `markdownContentDigest` is freshness evidence, not locator authorization. A digest mismatch enters the bounded external-edit reattachment or conflict flow and MUST NOT by itself classify the locator as belonging to another note.

A legacy marker without `inkbook-sidecar` performs no Vault scan. The adapter checks the deterministic adjacent path and the path derived from the current storage policy. Exactly one identity-valid candidate may be adopted, after which the locator is written through the marker protocol. Zero candidates enter missing-sidecar drift. Two valid candidates enter an explicit location conflict and neither is written.

The plugin MUST update both marker keys only through its injected `plugin.app.fileManager.processFrontMatter()` capability. Its callback synchronously mutates only `inkbook-annotations` and `inkbook-sidecar`, performs no await or nested host call, and preserves unrelated YAML properties. Rejection of the returned promise enters the visible marker-drift state with Retry. The plugin must not hand-edit the YAML block. Invalid or unparseable frontmatter also enters marker drift. A session that already holds a validated sidecar capability may continue safe persistence, but discovery or relocation that depends on an unavailable locator remains read-only.

The marker update is the sole metadata mutation outside native editor undo. It MUST NOT be represented as an Obsidian Editor or CodeMirror undo transaction. Before a first-annotation command enters its annotation-publication turn, its marker preflight invokes `processFrontMatter()` and does not retain a `NoteSession` queue turn while awaiting the host modification event. The observed source transaction and its forced checkpoint barrier are admitted independently. The annotation command resumes in a new turn only after checkpoint acknowledgement and complete token revalidation. A queue turn MUST NOT await an event whose processing requires that same turn to finish.

A successful owned preflight enters the exact `FirstSidecarPendingV1` state from [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md), keyed by note identity, expected resolved sidecar path, settings revision, operation ID, history-entry ID, recovery-attempt ID, source generation, and source digest, rather than external drift. Only that matching revalidated dispatch may create missing destination folders and call create-if-absent once for the expected sidecar. Every other annotation command is rejected without changing the pending state, and every unrelated automatic creation remains blocked. The first write contains the complete first annotated revision and never an empty revision-zero sidecar. Successful create acknowledgement exits the state. Cancellation, timeout, disposal, identity mismatch, policy mismatch, or create failure at a revalidated absent path converts it to `marker present, sidecar missing` drift without discarding acknowledged recovery. A create-if-absent path collision instead enters sidecar conflict without overwrite. Marker failure leaves Markdown unchanged, publishes visible marker drift, and offers Retry; annotation binding and persistence then resume in a new turn against the unchanged current snapshot. Either branch follows the same write-ahead recovery, scene publication, and sidecar save protocol.

Because the Markdown file and sidecar cannot be updated atomically as one Vault operation, drift is a defined state:

- marker present, sidecar missing: keep Markdown editable, disable overlay mutation, show a recovery action, and never create an empty replacement silently; the only exception is the identity-bound one-shot `first-sidecar-pending` transition above;
- marker present, locator invalid or locator identity mismatch: keep Markdown editable, refuse the target, and require explicit repair without probing unrelated paths;
- sidecar present, marker missing: offer to restore the marker after validating the sidecar;
- marker false, valid sidecar present: do not delete data; show an explicit disconnected-sidecar state;
- both absent: the note is unannotated.

After both first-annotation writes have succeeded, the steady state MUST contain the valid sidecar and the marker. Failure of either write leaves the recoverable drift state visible and MUST NOT delete or overwrite the file that was written successfully.

## 3. Top-Level Schema

The initial logical schema is:

```ts
export interface InkbookSidecarV1 {
  readonly format: "inkbook-obsidian-annotations";
  readonly schemaVersion: { readonly major: 1; readonly minor: number };
  readonly noteIdentity: {
    readonly vaultRelativeMarkdownPath: string;
    readonly markdownContentDigest: string;
    readonly sourceGeneration: SourceGeneration;
  };
  readonly storageLayout:
    | { readonly kind: "adjacent" }
    | { readonly kind: "vault-root"; readonly vaultRelativeRoot: string };
  readonly revision: number;
  readonly baseRevision: number | null;
  readonly savedAtEpochMs: number;
  readonly scene: SerializedSceneStateV1;
}
```

`SerializedSceneStateV1`, `NoteAppearanceV1`, every element and style, IDs, component revisions, attachments, object order, Groups, canonical JSON, and compact stroke bytes are owned by [Domain Model and Codecs](15-domain-model-and-codecs.md). The file and scene revision transitions are owned by [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md). Every SHA-256 digest is exactly 64 lowercase hexadecimal characters without an algorithm prefix and is calculated over the exact bytes named by its contract.

`markdownContentDigest` is SHA-256 over UTF-8 encoding of the exact JavaScript Markdown string admitted by `MarkdownSourceCoordinator`, with no line-ending, Unicode, whitespace, or BOM normalization. `sourceGeneration` is the durable monotonic coordinator generation represented by that digest. The string length and every anchor offset use the same UTF-16 snapshot. A sidecar raw-text digest is SHA-256 over UTF-8 encoding of the exact string returned by the acknowledged Vault read or process operation. Canonical sidecar and record digests use the canonical bytes defined in [Domain Model and Codecs](15-domain-model-and-codecs.md). These digest roles are not interchangeable.

The stored Markdown path and storage layout are integrity and relocation evidence, not authorization mechanisms. File access remains capability-bound to validated Obsidian Vault objects. A storage-layout migration changes only this metadata and the file location; it MUST NOT change scene data, note identity, revision history, or geometry.

## 4. Required Scene Data

The sidecar scene MUST contain:

- stable element IDs;
- an explicit object order;
- semantic element records;
- canonical stroke samples or compact deterministic encoding;
- one closed element binding record per element as defined in [Anchors and Layout](05-anchors-and-layout.md);
- optional Line and Arrow endpoint attachments to plugin-owned object ports;
- stable, acyclic group records when elements are grouped;
- styles and per-element revisions;
- no transient selection, hover, pointer capture, toolbar state, open popover, viewport bounds, or SVG DOM.

The sidecar MUST NOT contain Markdown text copies beyond bounded anchor context, arbitrary HTML, raw SVG, scripts, external URLs, image bytes, PDF data, web-embed data, search indexes, or device settings.

The sidecar persists only the note's selected background kind, horizontal spacing preset, and contrast. It MUST NOT persist effective host font size, measured line height, horizontal or vertical background period, line width, dot diameter, baseline phase, background rhythm regions, rendered cells, rendered grid lines, viewport coordinates, or host-layout revisions.

### 4.1 Binding Records

Serialized binding records use exactly the closed union and canonical anchor rules in [Anchors and Layout](05-anchors-and-layout.md). Highlight and underline records contain no enclosure margins. Enclosure records contain signed finite margins in effective line heights. The note-level Markdown digest binds stored source relationships to saved Markdown content and MUST NOT be duplicated per element. Runtime host-layout revisions, rendered fragments, current enclosure bounds, originating toolbar controls, and other view projection state are forbidden.

Binding inference, correction, attachment, detachment, and destination rebind are reversible operations protected by the write-ahead contract in [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md).

### 4.2 Construction Geometry Records

Table, 2D axes, 3D axes, optionally attached Line and Arrow, shapes, and strokes use the closed canonical records in [Domain Model and Codecs](15-domain-model-and-codecs.md).

All coordinates, dimensions, offsets, and vector components are finite unzoomed note-coordinate values within the absolute coordinate limit, and every angle is finite. Table width and height are each at least 2 note CSS pixels. Shape and Table `rotationRadians`, Stroke `selectionRotationRadians`, and persisted Group `selectionRotationRadians` are canonicalized to the half-open range `[-Math.PI, Math.PI)` and survive selection teardown, save, reload, Undo, and Redo. Area geometry rotates its local frame around `center`; a Stroke angle orients its selection-local sample bounds; a Group angle orients its aggregate frame after descendant geometry is materialized. `rowDividerOffsets` are strictly increasing local Y coordinates inside the open interval `(-height / 2, height / 2)`; `columnDividerOffsets` are strictly increasing local X coordinates inside `(-width / 2, width / 2)`. Every adjacent divider or outer edge is separated by at least 0.01 note CSS pixels. Each array contains at most 199 entries, so its derived track count is from 1 through 200. Every axis vector has non-zero length. Every pair of vectors in one axes object is non-collinear in the two-dimensional projection. A per-axis length edit preserves the normalized direction of that vector and every inter-axis angle; a rigid whole-object rotation rotates every vector by the same angle. Grid divisions are integers from 0 through 64. A 3D axes record is a two-dimensional projection of three vectors and contains no camera, perspective, depth buffer, text label, or separate 3D scene.

For an extent `E` and requested track count `C`, equal redistribution produces internal divider offset `-E / 2 + E * i / C` for every integer `i` from 1 through `C - 1`. Changing Rows applies this formula only to `rowDividerOffsets`; changing Columns applies it only to `columnDividerOffsets`. The unchanged dimension retains its exact offsets. If the requested result cannot satisfy the minimum separation, the command is rejected before mutation with an accessible explanation.

For an axis vector `v` and a pointer-derived note-space point `p`, length editing computes the positive scalar projection of `p - origin` onto `normalize(v)`, validates it against the coordinate limits, and stores `normalize(v) * newLength`. It does not accept perpendicular pointer movement as a direction change. Whole-object rotation is a separate operation that applies one finite rotation to all vectors.

Line and Arrow records store two finite free or attached endpoints plus an optional finite quadratic curve control point. A missing control point represents straight geometry. Endpoint fallback points, optional object-port attachments, and the control point are canonical geometry and MUST NOT be serialized as transient selection chrome.

Table cells, divider paths, axes grid guides, paths, handles, selection frames, control bounds, paint bounds, and spatial-index envelopes are derived. They MUST NOT be serialized as child elements or geometry authority. Divider offsets belong to the one Table record and MUST NOT be represented as Line elements. Each construction object has one stable element ID, one binding, one z-order position, one geometry revision, and one style revision.

A committed resize, rotation, Table-divider, or axis-length history entry stores exact revision-free prior and replacement semantic geometry and leaves the style record and style revision unchanged. Shape outline width, line width, Table border and divider width, axes and grid-guide width, cap size, dash pattern, stroke or outline opacity, fill opacity, color, and fill MUST NOT be duplicated into geometry records or multiplied into replacement geometry. Undo and Redo restore the exact opposite geometry and orientation values without cumulative numeric drift and assign a fresh monotonic geometry revision.

### 4.3 Group and Order Records

Groups and object order use the exact records and contiguous leaf-block rules in [Domain Model and Codecs](15-domain-model-and-codecs.md). Group selection and aggregate control frames remain derived. Group creation, transform, z-order, and removal use the closed reversible operations in [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md).

## 5. Save Protocol

One committed annotation operation or recovery-protected source checkpoint marks the sidecar session unsaved and enqueues a new save generation. Both pass through the one total `NoteSession` serialization order defined in [Architecture](04-architecture.md). An annotation command against a transient source generation cannot commit until the forced checkpoint barrier is acknowledged and every command token is revalidated. A stale checkpoint completion publishes nothing and enqueues no save.

A source checkpoint makes its immutable offset mapping and replacement Markdown digest durable without entering host history. The following sidecar encoding MUST use the exact immutable replacement Markdown snapshot for that digest, map every affected boundary with its association, and recompute affected bounded contexts and block metadata before persisting anchors. A source-generation or digest mismatch aborts that encoding and restarts it from the current durable generation. Save work begins after the active gesture is idle and MAY coalesce intermediate generations, but the latest generation MUST remain pending.

A save queue contains at most one active job and one replaceable latest waiting generation. Intermediate waiting generations are discarded before encoding. Canonical scenes and history use structural sharing, so capture MUST NOT clone the complete scene.

The persistence adapter limits active pipelines to two on desktop or Android tablet and one on Android phone. Before encoding, it validates the snapshot and worst-case encoded size against the sidecar and queue limits. A completed encoding waiting for Vault I/O remains active work. Success, failure, cancellation, conflict, or disposal releases the pipeline slot exactly once. Intermediate replaceable generations coalesce, while recovery and forced checkpoints are never discarded.

A save MUST:

1. capture one immutable canonical scene revision;
2. validate and encode it under resource limits;
3. compare the current resolved Vault sidecar identity, YAML locator, base revision, storage layout, and exact raw text retained when the session loaded or last saved;
4. for an existing sidecar, call `Vault.process()` and compare `currentText === baseRawText` inside its synchronous callback before returning the already prepared bounded encoding; any difference throws a conflict abort and writes nothing;
5. for a first sidecar, call `Vault.create()` and treat any intervening path collision as a conflict;
6. acknowledge only after the host write resolves successfully;
7. clear unsaved status only if the acknowledgement still matches the latest canonical revision.

The adapter normalizes every constructed Vault path and resolves known files through a `TFile` capability or `getFileByPath()`. It narrows every `TAbstractFile` from host events to the required `TFile` or `TFolder` branch before stat, read, process, rename, or trash work. File-only operations reject folders explicitly. The comparison base comes from the exact acknowledged raw value or one bounded `cachedRead()` before asynchronous encoding. The synchronous `Vault.process()` callback performs no await, nested Vault call, parsing, hashing, validation, or mutable application work.

Older save acknowledgements MUST NOT clear newer unsaved work. Each acknowledgement carries the exact expected prior and acknowledged replacement base plus explicit covered recovery IDs. Its one `RecoveryStore` compare-and-swap transaction removes exactly covered records and rebases every retained direct-successor attempt and checkpoint to the new base before the next waiting save starts. A gap, fork, conflicting base, or non-successor aborts cleanup, keeps newer work unsaved, and enters recovery conflict. A write failure keeps the in-memory scene and shows a persistent Retry action.

Validated and encoded element chunks are cached by element ID and revision. A warm single-element save reuses all unchanged chunks. Encoding is worker-first under the shared scheduler; a calibrated constant-time warm chunk update may remain on the main thread only when transfer overhead is higher. Encoding above 512 KiB MUST run in a cancellable worker on conforming platforms or in main-thread slices of at most 4 ms only when the worker is unavailable. The fixed idle debounce is 150 ms and maximum dirty time before a save starts is 2 seconds. Encoding time, transfer time, Vault operation time, and acknowledgement time are measured separately.

Revision and SHA-256 validation remain outside the synchronous `Vault.process()` callback for recovery, diagnostics, and conflict presentation. The callback performs no cryptography and reparses no JSON. `baseRawText` is limited by the 16 MiB sidecar ceiling, is shared once per note session, and is replaced only after a successful save or reload.

The exact string comparison remains the final conflict guard and has its own worst-case release benchmark for equal strings and a difference at the first, middle, or final UTF-16 code unit. The initial writable-sidecar ceiling is 16 MiB UTF-8 on desktop or Android tablet and 8 MiB UTF-8 on Android phone; the 16 MiB parser ceiling remains available for read-only recovery and export everywhere. The writable ceiling applies only when the persistence pipeline can retain its complete bounded input, output, comparison, and scratch working set. A platform MUST lower it prospectively if its worst-case comparison exceeds the main-thread limit or its complete UTF-16 residency cannot fit, and MUST NOT claim writable support for a size that fails either gate. Every required phone fixture, including the 5,000- and 10,000-element capacity scenes, must encode within the 8 MiB writable ceiling.

## 6. Conflict Handling

External sidecar changes are untrusted. If the on-disk revision or digest differs from the session base, the plugin MUST stop automatic writes and enter conflict state. It MUST NOT use last-writer-wins silently.

The first release offers:

- Reload external annotations, discarding only explicitly confirmed unsaved annotation operations;
- Keep local annotations as a separately saved conflict copy;
- Cancel and remain read-only.

Automatic scene merging is deferred until a deterministic operation-level merge contract and adversarial tests exist.

A local conflict copy is created beside the current resolved sidecar with the name `<note-base>.inkbook.conflict-<utc-basic-timestamp>-<eight-base32-chars>.json`. Creation MUST use create-if-absent semantics and MUST never overwrite an existing file. At most three conflict copies may exist per note. When the limit is reached, the plugin refuses another copy until the user explicitly deletes or moves one. Automatic cleanup is forbidden.

## 7. Rename, Move, and Delete

An owned `vault.on("rename", (file, oldPath) => ...)` handler branches on both `TFile` and `TFolder`. A folder rename durably records the normalized old and new path prefixes, then rekeys every affected loaded note session, resolved-sidecar identity, device-local zoom key, and recovery key. Each affected loaded sidecar updates `noteIdentity.vaultRelativeMarkdownPath`, its storage-layout-derived target path when required, and the note's YAML locator through the relocation saga before its session admits new annotation mutation. Work uses the session registry and a bounded prefix index over plugin-owned recovery and preference records, never a Vault-wide scan, proceeds in bounded chunks with a visible progress state, and resumes from the durable relocation cursor after interruption.

When a host rename changes the configured `vault-root`, the adapter validates and persists the replacement `SidecarStoragePolicyV1` through `saveData()` before admitting new sidecar creation. A save failure retains the replacement as an explicitly session-only value with persistent Retry and blocks first-sidecar creation under both old and new roots. It never recreates the old root implicitly. Restart loads only the last acknowledged policy and resumes any durable root-relocation record before new creation.

The relocation record retains bounded old-to-new prefix rules for unopened notes and sidecar roots. Every host rename advances a monotonic generation within that one device-local relocation history and has a unique relocation identity; one validated batch MAY contain multiple rules at that generation. Neither that history identity nor its generation is serialized into the synchronized sidecar or compared across devices. Matching compares normalized complete path segments, never arbitrary string prefixes. Resolution succeeds without a rule when the embedded Markdown path and YAML locator already equal the current validated targets.

A stale embedded path uses target-aware memoized traversal over at most 128 retained local rules and 32 strictly increasing generations. One search state is the pair `(normalizedPath, lastGeneration)`. The resolver never enumerates complete candidate chains, coalesces repeated states, and stores only one canonical predecessor selected by generation, descending matched-prefix length, and relocation identity. One resolution expands at most 4,096 unique states and 8,192 transitions, uses at most 1 MiB of transient resolver memory, and completes pure computation within 100 ms on desktop or Android tablet and 250 ms on Android phone. Worker-capable platforms run the traversal through the shared worker scheduler. The unavailable-worker fallback yields after at most 2 ms during active interaction and 4 ms while idle.

Rules apply only at complete path-segment boundaries and in increasing local generation order. The traversal explores historical path reuse rather than greedily accepting the oldest rule and accepts only a terminal state whose exact normalized path is the current Markdown or storage-layout-derived sidecar target. A repair is permitted only when at least one bounded route reaches that one target and the independent locator, storage-layout, marker, document-identity, digest, and sidecar-identity checks all agree. State, transition, hop, rule, byte, or total-time exhaustion, zero successful routes, or any competing validated target enters explicit read-only repair without partial mutation.

A host-approved inverse rename such as `A` to `B` to `A` is valid because candidate steps advance local generations and resolution stops successfully at the current validated target. Repeated path text is not itself a cycle. A newly created unrelated `A` later moved to `C` follows the candidate chain that reaches current target `C`, not an older dead-end `A` to `B`. Corrupt local rules with a non-increasing generation, self-map within one generation, ambiguous equal-generation result, or hop-limit overflow are excluded. Sequential and overlapping parent or child renames follow local host event order and use longest-prefix precedence only within the same generation.

On the next open of a located sidecar whose embedded path or YAML locator is stale, the adapter validates the target-aware local search and all independent identity evidence above before lazily repairing the embedded Markdown path, resolved sidecar location, and locator through the relocation and compare-and-swap contracts. It performs no Vault-wide scan. A synchronized sidecar whose embedded path and locator already equal the current validated targets remains valid regardless of absent, foreign, or numerically larger device-local rename generations. Prefix rules are removed only after an explicit bounded maintenance review proves no pending sidecars. The bounded rule limit is 128; reaching it preserves existing rules and makes annotation mutation for a newly affected unresolved path read-only until explicit review. Duplicate child-file or child-folder events are filtered by the same relocation identity. Unrelated folder renames are no-ops.

For a `TFile`, the handler classifies the event before acting. An owned Markdown source rename whose `oldPath` matches the note session enters the file relocation saga. The saga's own sidecar move is filtered only by its relocation identity. An external rename whose `oldPath` is the resolved sidecar of an open session immediately enters `marker present, sidecar missing` drift, blocks annotation mutation and automatic sidecar creation, preserves acknowledged recovery, and exposes explicit locator repair plus orphan review for the moved file. Unrelated file events are ignored. Vault, plugin settings, Markdown YAML, and IndexedDB cannot share one atomic transaction, so an admitted Markdown rename follows this saga:

1. block new annotation mutations and resolve old plus new Markdown, storage-layout-derived sidecar, and locator identities;
2. persist a relocation record with the completed-step index in `RecoveryStore`;
3. await the active save or cancel it after its bounded slice, retaining all unsaved operations in recovery;
4. create any validated missing destination folders, revalidate collision-free source and destination identities, and move the sidecar through `Vault.rename()`;
5. rekey the note-session registry, device-local zoom entry, and recovery-journal entries;
6. update `noteIdentity.vaultRelativeMarkdownPath` and `storageLayout` through the normal CAS save contract;
7. synchronously update only the two YAML marker keys through `processFrontMatter()` and await the resulting source checkpoint;
8. remove the relocation record and admit mutations again.

The resulting sidecar rename event is filtered from re-entry. Failure or crash after any step resumes from the durable step record or enters a persistent relocation-conflict state containing old and new identities. The host's already completed Markdown rename is never treated as rollback-capable.

If the sidecar destination exists, the move fails closed and reports a conflict. It MUST NOT overwrite the existing file.

An owned `vault.on("delete")` handler first classifies the concrete `TFile` or `TFolder`. Deletion of a resolved sidecar for an open session immediately enters `marker present, sidecar missing` drift, blocks annotation mutation and automatic sidecar creation, and preserves acknowledged recovery for explicit recovery. Deletion of an owned Markdown source leaves its located sidecar as an orphan candidate for explicit review. A deleted folder applies the same classification to affected loaded sessions through the bounded path-prefix index. Unrelated deletions are ignored. The plugin MUST NOT infer whether an item was trashed or permanently deleted from the event alone.

An empty scene does not cause automatic sidecar deletion. `Remove annotations from current note` is a separate destructive command. Before calling the injected `plugin.app.fileManager.trashFile()` capability, it records one removal-operation identity bound to the current note, sidecar identity, and expected delete event. Trash acknowledgement and the matching delete event form an order-independent two-signal barrier. The event is consumed exactly once without external drift only while that identity is current. Marker removal, session clearing, and recovery clearing cannot begin before both signals succeed.

The barrier has a two-second maximum from `trashFile()` invocation. Trash rejection, timeout, mismatched identity, file replacement, or disposal invalidates the removal identity before any later event is handled. The adapter then re-resolves the expected path: an absent expected sidecar enters recoverable `marker present, sidecar missing` drift, while a still-present sidecar keeps the pre-removal session and reports failure. A late event after invalidation is classified by the normal external-delete contract and is never consumed by the stale identity. Duplicate delivery cannot repeat marker removal or state clearing. After both barrier signals succeed, failure to remove both YAML marker keys enters recoverable drift with explicit Retry or restore action; session state and acknowledged recovery are cleared only after both keys are removed successfully. Inkbook MUST NOT fall back to permanent `Vault.delete()`.

An explicit orphan-sidecar review uses `vault.getFiles()`, filters only exact `.inkbook.json` suffixes, admits at most 10,000 candidate files per invocation, and yields after at most 512 inspected files or 4 ms. It MUST NOT use `getMarkdownFiles()`, inspect hidden folders, or scan the Vault at startup. Results beyond the bound remain unreviewed with a truthful continuation action.

## 8. Versioning and Migration

- A newer minor or major version opens read-only after bounded structural validation and MUST NOT be rewritten. Support requires an explicit migration plus golden preservation fixtures.
- A newer major version MUST open read-only. The plugin MUST not overwrite it.
- A migration parses into a bounded intermediate model, validates the complete result, and writes a new generation only after success.
- The original sidecar remains unchanged if migration fails.
- Migrations are pure, deterministic, idempotent, and covered by fixtures.

### 8.1 Storage-Location Migration

Saving a new default storage policy never scans the Vault and never silently relocates an existing sidecar. The Settings surface exposes an explicit `Migrate existing sidecars` action with a preview of source root, destination root, candidate count, collisions, unsupported paths, and estimated work. Candidate discovery is a user-initiated bounded `vault.getFiles()` pass over the exact `.inkbook.json` suffix. It admits at most 10,000 candidates per invocation and yields after at most 512 inspected files or 4 ms. Work beyond the bound requires an explicit continuation.

Each admitted sidecar migration uses one durable relocation identity and serialized steps: validate the source sidecar and paired Markdown identity, derive and create validated destination folders, reject an existing destination, recovery-protect unsaved annotation work, move through `Vault.rename()`, update `storageLayout` and `noteIdentity` through compare-and-swap, update the two YAML marker keys synchronously through `processFrontMatter()`, await the matching source checkpoint, then clear the relocation record. The operation neither changes scene revision nor creates a user history event. Cancellation is accepted only between sidecars or before a sidecar move begins.

A crash or failure resumes the exact recorded step. The plugin never overwrites a destination, never creates an empty replacement, never deletes the source as rollback, and never claims migration success before the sidecar, embedded layout, YAML locator, and checkpoint agree. An ambiguous source, changed digest, missing note, invalid path, external rename, setting revision change, or collision remains visible for explicit Retry, Skip, or Cancel. Existing notes not migrated continue to use their validated YAML locators on every device.

## 9. Recovery

Before canonical publication, operations and source checkpoints use the exact records, transitions, and transactional `RecoveryStore` port in [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md). V1 uses its Phase-0-proven IndexedDB adapter and never synchronous local storage. The source-checkpoint queue has at most one active write and one replaceable latest generation, with a 100 ms idle debounce and 500 ms maximum dirty time. Anchors remain in the referenced base scene and are mapped lazily rather than duplicated in the journal. The journal is keyed by a non-secret Vault identity hint and note path, is never synchronized as document content, contains no Markdown text, and encodes stroke deltas with [Domain Model and Codecs](15-domain-model-and-codecs.md).

The initial budget is 32 MiB total and 8 MiB per note. Startup probes backend availability, transaction behavior, and quota. If no conforming recovery backend is available, annotation mutation is read-only until the user resolves the failure; the plugin MUST NOT claim recoverability. Exceeding the budget rejects new annotation mutations before publication with a visible status rather than pretending they are recoverable. Interactive stroke generation uses the lower capture limit from [SVG Rendering](06-svg-rendering.md); the higher sidecar parser limit exists for compatibility and import validation.

On reopen, the adapter validates the sidecar source generation and digest, the current Markdown digest and length, and the strictly contiguous checkpoint chain through the recovery algorithm in [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md). A matching prefix is applied in order; a gap, fork, ambiguity, or unrelated digest enters bounded external-change reattachment or explicit review without publishing a guessed map. Recovery data is removed only after a sidecar acknowledging the corresponding scene and source generation plus digest succeeds or the user explicitly discards it.

## 10. Resource Limits

Before reading a sidecar, the adapter rejects `TFile.stat.size` above the file limit. V1 uses a bounded streaming JSON tokenizer over the returned string and MUST NOT pass the entire sidecar directly to an unconstrained `JSON.parse()`. The tokenizer enforces nesting, string, collection, and compact-codec limits before constructing the validated immutable model. Tokenize, validate, decode, and spatial-index construction are worker-first. Work above 512 KiB MUST run in a cancellable worker on conforming platforms or in main-thread slices of at most 4 ms only when the worker is unavailable. The largest schema-valid fixture that remains within every simultaneously applicable limit MUST load progressively under the same contract.

Before calling a whole-file Vault text read, the adapter rejects a stat size above the parser ceiling. Immediately after the read it rejects an over-limit string before tokenization or immutable scene construction. The streaming tokenizer accumulates encoded bytes, decoded string units, record counts, stroke points, and index-entry counts without allocating the corresponding domain graph. Any limit exhaustion opens the sidecar in explicit resource-limited read-only state and publishes no partial scene. Release benchmarks still measure actual peak heap against the platform gate.

The initial V1 parser limits are:

| Resource                                       |                        Limit |
| ---------------------------------------------- | ---------------------------: |
| Sidecar UTF-8 bytes                            |                       16 MiB |
| Scene records, annotation elements plus groups |                      100,000 |
| Stroke points                                  |                500,000 total |
| Points in one stroke                           |                      200,000 |
| Anchor context before or after                 |        256 UTF-16 code units |
| Text-range span                                |     65,536 UTF-16 code units |
| Absolute binding margin                        | 1,024 effective line heights |
| Group nesting                                  |                           32 |
| Table rows or columns                          |                     200 each |
| Axis grid divisions                            |                           64 |
| Line or Arrow endpoints attached to one target |                        1,024 |
| Absolute note coordinate                       |        10,000,000 CSS pixels |
| JSON nesting                                   |                           64 |

Limits are conjunctive and MUST be enforced before or during parsing with bounded memory. The 100,000-record value is an independent parser-abuse ceiling, not a supported interactive-capacity claim and not a requirement that one file reach every independent ceiling simultaneously. Values at and immediately over reachable combined boundaries require full fixtures. An independent ceiling that cannot be reached before another limit rejects the input is verified through isolated tokenizer and admission tests.

The 8 MiB phone writable ceiling covers the required 10,000-element workload even when its 250,000 stroke points reach the compact codec's declared worst-case decoded-byte ceiling, while retaining more than 10 percent headroom for the required bindings and envelope. Phase 1 freezes the actual generated fixture size before its exit and fails the contract if that measured size plus 10 percent exceeds 8 MiB. The 16 MiB parser ceiling provides additional bounded read-only recovery and export tolerance and is not a larger phone write claim. A valid sidecar or required stress fixture can exceed a synchronization plan's file-size limit. Users must still enable synchronization of other file types so `.inkbook.json` is eligible for transfer. Because Obsidian does not expose the user's plan as a trusted plugin capability, onboarding and the Storage and Recovery settings group MUST show the actual encoded size, warn that plan limits may prevent transfer, direct the user to verify the current documented plan limit, and never claim that a file will synchronize. The plugin MUST also detect the already-overwritten-sidecar case through its base revision, digest, conflict, and recovery flow because an external sync engine may use last-modified-wins before the plugin observes the file.
