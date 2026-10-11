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

Window and worker adapters share a portable FIFO task transport with injected
host operations. Each adapter lazily owns one reusable `MessageChannel` and at
most one posted wakeup; cancelling a task removes it immediately. A delivered
wakeup executes one callback, leaving admission, priorities, and absolute
deadlines entirely with `SharedFrameScheduler`. Unavailable or failed channels
fall back to cancellable timers. Positive-delay semantic timers keep their
requested delays. Scheduler disposal closes both ports and clears pending tasks.
Production document-runtime termination disposes only its worker-owned scheduler;
main-thread fallback never disposes the shared owning-window scheduler.

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

Interactive history preparation, including structural mutations, selection styles,
Arrange, Store replacement, and their Undo/Redo replay, uses the same FIFO `frame`
queue as rendering. It must not remain
behind a scene that can consume the complete allowance on every frame. Pointer
and camera `input` still precede both. Speculative scene reserves and document
prewarming wait for interactive leases to finish; required visible publication
continues through the shared frame budget. Other asynchronous preparation keeps
its default `background` priority. The main-thread encoding and dispatch of a pending
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

Resumable sample validation, copying, comparison, bounds, encoding, and contour
preparation use bounded producers shared with synchronous callers. Synchronous
wrappers drain those producers; asynchronous consumers consult the injected
scheduler between their steps. A step boundary alone never forces a frame or
renews the work deadline. The preparation runner returns completed results synchronously. It
creates a Promise only for an actual central scheduler handoff; per-record callers
await only that Promise. After resumption, one iterative drain owns subsequent
handoffs, avoiding a retained chain of continuation Promises.
Public mutable values are staged into private candidates
and those exact values are validated before atomic adoption. Cancellation releases
staging without publishing a partial Store or worker model. Native allocations and
final string or byte publication remain indivisible operations. Atomic map and
cache adoption, snapshot-array materialization, final unlock adoption, and the
ordered-ID digest still traverse bounded document state synchronously; these
boundaries do not establish complete preemptibility.

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
