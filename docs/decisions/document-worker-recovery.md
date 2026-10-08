# Bounded Document Worker Recovery

## Status

Accepted. The canonical runtime rules are in [Document Worker, Autosave, and Export](../rendering-and-performance.md#document-worker-autosave-and-export).

## Problem

Ordinary queue conflicts and model-baseline disagreements could invalidate a healthy worker. A wall-clock timeout could also classify deliberate input or scheduler pauses as failures. Immediate fallback then left an entire session on the main thread without identifying the failing session or boundary.

## Decision

Separate retryable operation failures and deliberate speculative cancellation from executor failures. Preserve strict protocol identities and validation. Count only active request time, keeping the watchdog's semantic I/O timer independent of presentation-window ownership and cooperative CPU budgets.

Attempt bounded native replacement before fallback. Share the replacement budget across opening and later operations, and serialize recovery so two failures cannot create parallel executors. Rebuild from the authoritative model instead of copying a potentially failed worker baseline. Preserve dirty state and active save proofs; executor recovery cannot repeat an indeterminate Vault write.

Report failures through bounded, content-free console warnings. Do not retain the temporary worker-event ledger or zoom recordings. Avoid arbitrary error text and document payloads. A constructed port and a completed request are distinct evidence.

## Consequences and Verification

Native execution is preferred but cannot be guaranteed when browser capabilities or worker startup fail. Exhausted recovery remains an explicit error; there is no unbounded retry loop. Main-thread fallback continues through the owning window's central scheduler.

Deterministic tests observe queue capacity, live executor ownership, timer cancellation, pause/resume accounting, complete model synchronization, stale-result rejection, initial cancellation, and retained dirty/save state. Window transfer must not strand an outstanding watchdog. Real Obsidian checks cover normal worker startup and shared zoom/culling interactions; physical Wayland trackpad delivery remains a separate hardware requirement.
