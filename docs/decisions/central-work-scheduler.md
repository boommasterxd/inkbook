# Central Work Scheduler

## Status

Accepted. This supersedes independent per-consumer work deadlines and the
500-millisecond autosave inactivity delay. The canonical runtime contract is
[Central Work Scheduling](../rendering-and-performance.md#central-work-scheduling).

## Problem

Renderer, selection, eraser, store preparation, preview adoption, and persistence
previously renewed separate time allowances. Several individually bounded tasks
could therefore exceed the intended total window allowance. Unconditional frame
waits and worker input polling could also delay useful work without protecting an
additional frame.

## Decision

Use one injected `WorkScheduler` per owning window and the same portable
`SharedFrameScheduler` in each document worker with a task-admission host policy. The domain layer owns the
platform-independent admission policy; window and worker adapters own native
timing resources. Workspace composition owns lifetime and window selection.

Keep the existing frame preferences and 55-percent cooperative work allowance.
Every consumer shares an absolute epoch deadline. Input, frame, and background
queues preserve priority with FIFO order within each class. A checkpoint without an
exhausted budget continues synchronously; a real frame dependency uses an
explicit frame wait. A new native epoch starts its work clock once at central
callback entry, preserving already spent synchronous allowances. Native frame
timestamps identify frames and drive animations; treating their earlier time as
work already spent can fragment publication into many tiny browser updates.
Separate host-task admissions account for nested Promise
continuations before admitting competing work. Live settings update existing
schedulers and workers rather than creating fresh per-operation allowances. A worker
uses the configured slice duration but resumes after a central task handoff instead
of waiting for the remainder of a synthetic display frame. Main-thread fallback
work still shares its owning window's frame budget. Cache prewarming starts through
a checkpoint without an unconditional frame wait.

Terminal selection-transform preparation, including Store replacement and its
Undo/Redo replay, uses the same FIFO `frame` queue as rendering. It must not remain
behind a scene that can consume the complete allowance on every frame. Pointer
and camera `input` still precede both; other asynchronous preparation keeps its
default `background` priority. The main-thread encoding and dispatch of a pending
worker export also use `frame` admission, preserving overlap between export and
scene work instead of holding the worker idle until rendering finishes. The
autosave debounce remains unchanged. Required viewport contour preparation and
its background-purpose model synchronization use frame admission during
navigation; drawing still gates them. Other requests and result adoption retain
background admission and defer during navigation. An already running worker
export may finish within the central budget, with main-thread adoption deferred.
This changes admission order,
not the shared budget or the requirement to yield only when necessary.

Remove count-based CPU slice quotas and forced handoffs while the shared budget remains. Preserve bounded indivisible work units, frame publication caps, input-priority gates,
transaction generations, and cancellation checks. Detached preview preparation
quanta recheck the shared deadline without forcing a new frame while budget
remains; only actual paint dependencies or visible publication caps require a new
frame. Selection-query
and eraser-finalization work quanta likewise recheck cancellation and the shared
deadline without forcing a new frame while budget remains. An atomic native operation
cannot be interrupted by this policy. Semantic gesture delays, animation
durations, and I/O timeouts retain their own purpose. Autosave now starts after
1,000 milliseconds of content inactivity; explicit flush and lifecycle save
boundaries remain independent of that debounce.

Shared preview recognition follows an open requesting window, preferring a visible
requester, while retaining one validation per document. Pending scheduling waits
can transfer without restarting validation. Runtime snapshot copies, clipboard
validation, and replacement-heap preparation expose bounded checkpoints; final
store publication remains atomic.

Require the scheduler for future cooperative implementations in `AGENTS.md`.
The source-layout AST gate rejects native work scheduling and private deadline
renewal outside approved boundaries. Narrow semantic event-ordering and finite
refresh-measurement sites are documented exceptions, not additional work queues.

## Consequences and Verification

The policy can coordinate admitted JavaScript work but cannot guarantee a
physical frame duration or make full-document atomic operations cheap. Browser
style/layout and indivisible geometry remain separate performance concerns.

Deterministic tests cover competing consumers, nested asynchronous waits, live
budget changes, idle restart, cancellation, window separation, hidden progress,
and resource cleanup. Cadence-sensitive admission contracts retain all five
supported refresh profiles. Physical-device latency still requires the manual
verification defined in [Quality and Testing](../quality-and-testing.md).
