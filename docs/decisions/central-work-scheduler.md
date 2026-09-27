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
`SharedFrameScheduler` policy in each document worker. The domain layer owns the
platform-independent admission policy; window and worker adapters own native
timing resources. Workspace composition owns lifetime and window selection.

Keep the existing frame preferences and 55-percent cooperative work allowance.
Every consumer shares an absolute epoch deadline. Input, frame, and background
queues preserve priority with FIFO order within each class. A checkpoint without an
exhausted budget continues synchronously; a real frame dependency uses an
explicit frame wait. Separate host-task admissions account for nested Promise
continuations before admitting competing work. Live settings update existing
schedulers and workers rather than creating fresh per-operation allowances.

Preserve bounded work units, frame publication caps, input-priority gates,
transaction generations, and cancellation checks. An atomic native operation
cannot be interrupted by this policy. Semantic gesture delays, animation
durations, and I/O timeouts retain their own purpose. Autosave now starts after
1,000 milliseconds of content inactivity; explicit flush and lifecycle save
boundaries remain independent of that debounce.

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
