# Architecture and Runtime Flows

This document is an informative visual map of Inkbook's runtime architecture. The linked specifications remain normative when a diagram omits a detail or appears ambiguous.

## System Ownership

```mermaid
flowchart LR
  subgraph host["Obsidian host"]
    reading["Reading view"]
    readingPreview["Host-owned native SVG preview"]
    live["Live Preview"]
    source["Source mode"]
    noteScroller["Native note scroller and right-hand scrollbar"]
  end

  reading --> readingPreview
  reading --> readingChild["MarkdownRenderChild"]
  live --> liveWidget["CodeMirror WidgetType"]
  source --> rawMarkdown["Raw Markdown embed"]

  readingChild -. "Progressively adds activation" .-> readingPreview
  liveWidget --> widgetPreview["Widget-owned static preview and editor mount"]
  readingChild --> coordinator["WorkspaceEditorCoordinator"]
  liveWidget --> coordinator

  coordinator --> session["At most one document session"]
  coordinator --> pending["At most one pending activation"]
  session --> editor["Editor orchestration"]
  session --> store["Normalized element store"]
  session --> history["Canvas command history"]
  store --> index["Uniform spatial index"]
  store --> connections["Reverse endpoint connection map"]

  editor --> chrome["React application chrome"]
  editor --> scene["Imperative SVG scene renderer"]
  store --> scene
  index --> scene
  connections --> scene

  session --> persistence["Main-thread persistence orchestration"]
  persistence --> worker["One document worker"]
  worker -. "Validated data, clipboard payloads, SVG output, and hashes" .-> persistence
  persistence --> vaultAdapter["Public Obsidian vault adapter"]
  vaultAdapter --> svgFile["Complete SVG file and editable snapshot"]
  editor --> noteScroller
```

The presentation owner releases its own DOM, React root, portals, listeners, observers, timers, pointer capture, and animation frames. The coordinator owns only the authoritative session, worker, activation records, and any bounded detached-save or recovery lease. React renders controls and coarse state, never ink elements or the pointer-to-frame render path.

## Document Session Lifecycle

```mermaid
stateDiagram-v2
  state "load-error" as loadError
  state "save-error" as saveError
  state "detached save lease" as detachedSaving
  state "headless save-error recovery" as headlessRecovery
  [*] --> locked
  locked --> unlocking: current activation request
  unlocking --> active: validated load and complete runtime store
  unlocking --> locked: cancelled or superseded
  unlocking --> [*]: clean detached session released
  unlocking --> loadError: validation or load failure
  loadError --> unlocking: Retry
  loadError --> locked: Discard or Dismiss
  loadError --> [*]: presentation removed

  active --> locking: lock or different document request
  active --> saveError: autosave conflict or failure
  active --> [*]: clean presentation detaches
  locking --> locked: exact revision saved and confirmed
  locking --> saveError: conflict or save failure
  saveError --> locking: Retry
  saveError --> active: Cancel while attached
  saveError --> locked: Save local copy and confirm
  saveError --> headlessRecovery: presentation detaches

  active --> detachedSaving: dirty presentation detaches
  locking --> detachedSaving: presentation detaches during save
  detachedSaving --> active: same document reattaches
  detachedSaving --> [*]: save confirmed with no attachment
  detachedSaving --> headlessRecovery: conflict or save failure
  headlessRecovery --> detachedSaving: Retry
  headlessRecovery --> saveError: same document reattaches
  headlessRecovery --> headlessRecovery: recovery modal closes
  headlessRecovery --> [*]: Reload external or Save local copy
```

This diagram describes the authoritative document-session state. Its `load-error` state is reached only when unlocking cannot produce a validated runtime document: Retry returns that session to `unlocking`, while Discard or Dismiss returns it to `locked`. By contrast, the per-embed state table in the [Implementation specification](specification.md#document-and-editor-states) also allows a presentation-local `active` to `load-error` transition when editor-chrome mounting fails. That presentation disposes its scene, returns to the static preview, and exposes retry UI without changing the authoritative document session from `active`; normal lock, detach, and recovery coordination still govern that session.

Only one workspace session may be in `unlocking`, `active`, `locking`, `save-error`, detached-save, or headless-recovery mode. Detached saving and headless recovery are coordinator ownership modes for the same document session, not additional persisted editor states.

## Activation Across Tabs, Panes, and Pop-out Windows

```mermaid
sequenceDiagram
  participant Requested as Requested attachment
  participant Coordinator as WorkspaceEditorCoordinator
  participant Current as Current attachment
  participant Session as Current document session
  participant Vault as Obsidian Vault

  Requested->>Coordinator: Request with token, document ID, attachment ID, and generation
  Coordinator->>Coordinator: Reject stale, unmounted, or superseded request

  alt Same current attachment and generation
    Coordinator-->>Requested: Return the current active outcome
  else Same document in another presentation
    Coordinator->>Current: Cancel gesture and release presentation resources
    Coordinator->>Session: Retain the store, history, and worker
    Coordinator-->>Requested: Attach the existing session without reload
  else Different document
    Coordinator->>Coordinator: Replace the single pending slot with this request
    Coordinator->>Current: Cancel the uncommitted gesture and disable input
    Coordinator->>Session: Lock the exact latest revision
    Session->>Vault: Validated complete-file save
    Vault-->>Session: Read-back revision and output-hash confirmation
    alt Save confirmed and request is still current
      Coordinator->>Session: Release the previous session
      Coordinator-->>Requested: Begin unlock
    else Conflict or failure
      Coordinator->>Session: Retain recovery state
      Coordinator-->>Requested: Block activation until recovery completes
    end
  end
```

An attachment is identified by its opaque ID and generation, so the same file mounted in another tab or window does not create a second store. A widget unload cancels its matching pending request. Separate Obsidian processes have separate coordinators and rely on file conflict detection rather than an in-memory workspace lock.

## Pointer Input, Preview, Commit, and Rendering

```mermaid
flowchart TD
  pointer["Pointer, wheel, contextmenu, or keyboard event"] --> inputSurface["One focusable transparent input surface"]
  inputSurface --> arbitration{"Input arbitration"}
  arbitration --> palm["Ignore touch as palm input"]
  arbitration --> eraser["Temporary or active eraser"]
  arbitration --> pinch["Two-touch pinch"]
  arbitration --> elementMove["Touch selects or moves hit element"]
  arbitration --> activeTool["Pen, mouse, or enabled-finger active tool"]
  arbitration --> navigation["Note scroll, page pan, or long press"]
  arbitration --> menu["Spatial-index target and native context menu"]

  eraser --> gesture["Input reducer gesture state"]
  pinch --> gesture
  elementMove --> gesture
  activeTool --> gesture
  navigation --> gesture
  menu --> menuAction{"Menu action?"}
  menuAction -->|No mutation| releaseMenu["Return focus without history or save work"]
  menuAction -->|Canvas mutation| command
  menuAction -->|Host note or embed mutation| editorTransaction["One Obsidian Editor transaction and confirmed FileManager decision"]

  gesture --> capture["Acquire pointer capture"]
  capture --> scrollGuard["Pen-only scroll-position guard"]
  scrollGuard --> hostScroller["Resolved native Obsidian note scroller"]
  hostScroller --> preview["Imperative gesture feedback or preview"]
  capture --> preview
  preview --> frame["At most one scene update per animation frame"]
  gesture --> finish{"Gesture outcome"}
  finish -->|Cancel| revert["Revert preview and release resources"]
  finish -->|Commit| command["One atomic command"]

  command --> release["Finalize preview and release pointer resources"]
  command --> transaction["Update records, order, bounds, index, and connections"]
  transaction --> delta["Publish one consistent store delta"]
  delta --> sceneDiff["Diff visible IDs and changed nodes"]
  sceneDiff --> frame
  delta -. "Coarse committed UI state only" .-> react["React toolbar and dialogs"]
  command --> revision["Increment history and persisted revision once"]
  revision --> autosave["Schedule autosave after 500 ms of inactivity"]
```

Pointer movement applies direct imperative feedback and creates no element records, history entries, React renders, or save work. Committed SVG paths and decorative overlays receive no pointer events and own no listeners. Creation and transformation gestures mutate preview nodes, while navigation updates the owned scroller or camera. The reducer states are `idle`, `touch-pending`, `note-scroll`, `page-pan`, `element-move`, `lasso`, `eraser-gesture`, `tool-gesture`, and `pinch`. Candidate lookup for hit testing, context targets, erasing, culling, and snapping uses the spatial index. A target transform follows the reverse connection map so connected arrow and line endpoints update without scanning all elements.

The native-scrollbar lease is acquired before Inkbook's first width-derived preview or editor measurement and remains unchanged across lock and unlock for the complete recognized-presentation lifetime. It is not a pointer-state transition. Inkbook measures its own background container and clamps its right edge to the resolved scroller's client edge; the canvas never adopts the pane width or covers the right-hand gutter. A live layout move acquires the new lease and adopts post-style geometry before releasing the old lease in the next frame, while a destroyed presentation releases immediately. The pen scroll guard only restores an unexpected `scrollTop` change in the next animation frame.

The command history in this flow belongs to the Inkbook canvas. Creating an embed, replacing its Markdown target, or applying other host-note text changes uses one Obsidian `Editor` transaction and the pane's own undo history instead.

## Imperative Rendering and Frame Scheduling

```mermaid
flowchart TD
  storeDelta["Domain-classified store delta with versions"] --> dirty["Set geometry, paint, order, connection, or visibility flags"]
  dirty --> scheduler{"Scene frame already pending?"}
  gestureUpdate["Gesture, camera, scroll, or zoom update"] --> scheduler
  hostUpdate["Resize or host-layout invalidation"] --> scheduler

  scheduler -->|No| queue["Queue one animation frame"]
  scheduler -->|Yes| coalesce["Coalesce reasons into the pending frame"]
  queue --> frame["Begin scene frame"]
  coalesce --> frame

  frame --> generation{"Generation is current?"}
  generation -->|No| discard["Discard stale work"]
  generation -->|Yes| priority["Prioritize live input, camera and overlays, mounted changes, visibility, then background"]
  priority --> reads["Read phase: cached geometry, viewport, and layout"]
  reads --> domainGates["Evaluate dirty-domain gates without DOM writes"]
  domainGates --> sceneValues["Prepare dirty camera and overlay values"]
  domainGates --> contentGate{"Content or visibility dirty?"}
  domainGates --> backgroundGate{"Background dirty?"}
  contentGate -->|No| reuseContent["No content calculation or write"]
  contentGate -->|Yes| visibilityGate{"Visibility or viewport dirty?"}
  visibilityGate -->|No| mountedChanges["Use dirty mounted IDs only"]
  visibilityGate -->|Yes| visibleRect["Calculate viewport plus 80 screen pixels of overscan"]
  visibleRect --> spatialQuery["Query spatial grid and bounded overflow collection"]
  spatialQuery --> candidateCache{"Same cell range and no relevant cell delta?"}
  candidateCache -->|Yes| reuseCandidates["Reuse numeric candidate slots"]
  candidateCache -->|No| refillCandidates["Refill reusable slots and epoch markers"]
  reuseCandidates --> exactBounds["Reject nonintersecting conservative bounds"]
  refillCandidates --> exactBounds
  exactBounds --> visibleSet["Fill reusable next-visible slots"]

  visibleSet --> diff["Diff against the ID-to-node map"]
  storeDelta --> changedIds["Changed IDs and affected rank data"]
  changedIds --> mountedChanges
  mountedChanges --> work
  diff --> work["Entrants, exits, changed nodes, and affected reorders only"]
  work --> mountBudget{"Absolute deadline, 4,096 stroke points, and 16,384 geometry cost permit the next entrant?"}
  mountBudget -->|No| nextFrame
  mountBudget -->|Yes| pathCache{"Path cache matches ID plus geometryVersion?"}
  pathCache -->|Yes| reuse["Reuse the path"]
  pathCache -->|No| build["Build only the required mounted path"]
  reuse --> applied["Compare applied node versions and attributes"]
  build --> applied
  applied --> preparedContent["Prepare changed content attributes or child order"]

  backgroundGate -->|No| reuseBackground["No background calculation or write"]
  backgroundGate -->|Yes| backgroundCache{"Aligned background cache key changed?"}
  backgroundCache -->|No| reuseBackground
  backgroundCache -->|Yes| rebuildBackground["Prepare one regenerated bounded compound path"]

  sceneValues --> prepared["Join prepared domain results"]
  reuseContent --> prepared
  preparedContent --> prepared
  reuseBackground --> prepared
  rebuildBackground --> prepared
  prepared --> writes["Write phase: apply only prepared changed DOM state"]
  writes --> bands["Preserve fixed highlight and content render bands"]
  bands --> release["Release replaced entries and enforce DOM and cache caps"]
  release --> remaining{"Input-aware reconciliation work remains?"}
  remaining -->|Yes| nextFrame["Keep the last complete frame and queue one successor"]
  nextFrame --> frame
  remaining -->|No| complete["Frame complete without a React render"]
```

The ordinary frame cost follows reusable spatial-index candidates, mounted visible elements, and the classified published delta, rather than all 10,000 stored strokes. The renderer mounts only the viewport plus exactly 80 screen pixels of overscan and mutates only entering, exiting, changed, or affected reordered nodes and attributes. Large or unusually dense viewports reconcile every exact visible element through a persistent band-and-rank cursor. Each slice uses the frame's absolute deadline plus fixed point and geometry budgets, admits at least one element for progress, and reuses the unchanged viewport query while the last complete frame remains visible.

All layout reads happen before pure calculations and DOM writes, so the frame does not alternate between layout measurement and mutation. Path and anchor entries are valid only for the same element ID and geometry version. The recently unmounted main-thread path LRU is capped at 4,096 entries and 32 MiB, and the target-anchor LRU at 4,096 targets and 8 MiB, with the active-document memory ceiling taking precedence. Background guides use bounded SVG pattern tiles aligned to the visible range and regenerate only when their geometry key changes. Transform previews use SVG transforms, and visible connected endpoints follow their target during the same frame. Canonical paths, bounds, spatial-index cells, and endpoint records update once on commit.

React receives at most one coarse notification after a consistent committed transaction or discrete UI transition. Pointer samples, preview geometry, camera changes, culling, snapping, connection propagation, and animation-frame work stay entirely in the imperative renderer. This prevents the 10,000-stroke scene from producing component renders or virtual-tree work on the hot path.

## Document Worker Boundary and Queue

```mermaid
flowchart LR
  subgraph main["Main thread"]
    hostApis["Obsidian, Vault, and Clipboard APIs"]
    input["Pointer, scroll, camera, layout, and live paths"]
    model["Store, history, spatial index, hit testing, snapping, and culling"]
    orchestration["Session, worker epoch, purpose-specific operations, revisions, and bounded result adoption"]
  end

  subgraph documentWorker["One document worker"]
    unlock["UTF-8, XML, metadata, schema, limits, and migrations"]
    clipboard["Clipboard encode, decode, validation, placement, and ID plan"]
    export["Incremental SVG fragments and complete output"]
    verification["Hashes, preflight, and read-back verification"]
    background["Interruptible fragment prewarming"]
  end

  orchestration -->|"Bounded batches and operation identity"| unlock
  orchestration --> clipboard
  orchestration --> export
  orchestration --> verification
  orchestration --> background
  unlock -->|"Validated runtime batches"| orchestration
  clipboard -->|"Validated payload or insertion records"| orchestration
  export -->|"Complete SVG plus revision and generation"| orchestration
  verification -->|"Structured confirmation or conflict"| orchestration
  hostApis --> orchestration
  orchestration --> hostApis
  input -. "Never crosses worker boundary" .-> model
```

The worker runs one non-preemptive job. Unlock and migration are exclusive before activation. Active-session priority is lifecycle and recovery verification, one explicit clipboard operation, one coalesced due export, then interruptible prewarming. Worker failure invalidates its epoch and switches once to the same pure algorithms in bounded, input-aware main-thread slices. Export generations order replaceable export results. Only admission of a current result creates the non-replaceable active save operation that spans preflight through write classification; clipboard plus unlock use independent operation IDs. There is no worker pool and no worker owns DOM, React, input, camera, scroll, the spatial index, or an Obsidian API.

## Incremental Export, Complete Save, and Recovery

```mermaid
sequenceDiagram
  participant Editor as Editor session
  participant Worker as Document worker
  participant Vault as Obsidian Vault
  participant Coordinator as WorkspaceEditorCoordinator

  Editor->>Editor: Commit revision and start 500 ms inactivity timer
  Editor->>Editor: Wait for inactivity and no live gesture
  Editor->>Worker: Dispatch one incremental export generation
  Note over Editor,Worker: Later commits coalesce into one successor revision
  Worker-->>Editor: Complete SVG with model revision, export generation, and hash
  alt Export generation or revision is stale
    Editor->>Editor: Discard output and keep the coalesced successor
  else Result matches the current editor revision
    Editor->>Editor: Admit one non-replaceable active save operation
    Editor->>Vault: Uncached read for exact-base preflight
    Vault-->>Editor: Current persisted bytes
    Editor->>Worker: Validate persisted revision and hash under the same save operation
    Worker-->>Editor: Preflight result

    alt Persisted base differs
      Editor->>Editor: Preserve dirty authoritative state without writing
      Editor-->>Coordinator: Enter attached or headless save-error recovery
    else Editor revision advanced during preflight
      Editor->>Editor: Terminate the unwritten active save and dispatch the coalesced successor
    else Exact base matches and editor revision remains current
      Editor->>Vault: Vault.process with synchronous exact-base and current-editor-revision check
      Vault-->>Editor: Write completed, rejected, or indeterminate
      Editor->>Vault: Read back the file
      Vault-->>Editor: Persisted bytes
      Editor->>Worker: Validate revision and complete-output hash under the same save operation

      alt Prepared revision and hash confirmed
        Worker-->>Editor: Confirmation
        Editor->>Editor: Advance the confirmed vault base to that revision and hash
        alt Editor revision still equals the confirmed revision
          Editor->>Editor: Clear dirty state for that revision
          Editor-->>Coordinator: Release a detached lease only if this is its exact latest revision
        else Editor revision advanced during write or read-back
          Editor->>Editor: Stay dirty and recheck the prepared successor
          alt Successor epoch and export generation are current and its revision exactly equals the editor revision
            Editor->>Editor: Promote it and preflight against the new confirmed base
          else Successor is stale or the latest export is still pending
            Editor->>Editor: Discard a stale prepared result and await the latest export
          end
        end
      else Confirmed base is unchanged
        Worker-->>Editor: A successor or retry is safe
        Editor->>Editor: Keep dirty state and retain one successor or retry trigger
      else External conflict, invalid output, or write failure
        Worker-->>Editor: Recovery required
        Editor->>Editor: Preserve dirty authoritative state
        Editor-->>Coordinator: Enter attached or headless save-error recovery
      end
    end
  end
```

Incremental export updates worker-owned fragments, but every successful persistence pass writes one complete SVG file containing one matching editable snapshot. At most one export request, one non-replaceable active save, one prepared successor, and one `Vault.process()` call exist per session. A newer export may replace only the prepared successor. Every full host read is serialized per normalized path and guarded by the public file identity plus path, timestamps, and size before and after materialization; changed or oversized bytes are rejected. Read-back of an active save always updates the confirmed vault base; it clears dirty state and releases a detached lease only when that revision is still the authoritative latest revision. If the executor fails after a write begins, a new-epoch verification operation checks the immutable old save ID, revision, and hash without repeating the write. Detachment removes presentation resources immediately but does not cancel dirty persistence work.

The sequence shows an existing SVG save. Initial creation uses `Vault.create()` after path validation and then applies the same worker-assisted read-back confirmation. Attached recovery offers Retry, Save local copy, and Cancel. Headless recovery offers Retry, Reload external version, and Save local copy; closing its modal preserves the recovery session. Recovery results are bound to their basis revision, workspace token, session and worker epoch, and attached presentation when applicable. A same-document handoff cancels unresolved recovery before reattachment, and a non-active phase never mounts an editable scene.

## Cross-cutting Invariants

- One plugin and `App.workspace` own one coordinator, one current session, and one pending activation slot.
- One session owns one normalized store, one canvas command history, one spatial index, and one document worker while attached or draining. Only an attached presentation owns an imperative SVG scene.
- The main-thread pointer and animation-frame path performs no React render, full-store scan, full-snapshot clone, or synchronous full-file parse.
- The 10,000-stroke acceptance dataset remains in the store, while only viewport-visible SVG nodes plus bounded overscan are mounted.
- Presentation detachment never discards dirty data. A conflict never silently overwrites an external version.
- Static SVG remains a safe locked preview. The validated editable snapshot is the editing source of truth.
- Active and standalone document graphics use the same self-contained light and dark palette. A host theme change updates one presentation root per mounted note without geometry work, export, revision change, or vault write.
- Plugin unload and process termination cannot guarantee completion of asynchronous writes; normal autosave and read-back confirmation reduce, but do not remove, that risk.

## Canonical Contracts

- [Implementation specification](specification.md)
- [Obsidian integration](obsidian-integration.md)
- [Editor tools](editor-tools.md)
- [Rendering and performance](rendering-and-performance.md)
- [File format and geometry](file-format.md)
- [Standalone SVG envelope and theme rendering](svg-envelope.md)
- [Quality, performance, animation, and testing](quality-and-testing.md)
