# Performance Base Comparison

## Status

Accepted, 2026-09-16. Replaces automatic performance-baseline promotion.

## Context

An additional historical source reference requires a second comparison and maintenance. Better-only promotion can leave individual improvements unprotected when other metrics do not qualify. Per-metric references would add complexity and potentially more benchmark executions.

## Decision

Keep the existing same-runner comparison against the PR base and remove the separate historical anchor, moving-reference resolver, promotion reports, and post-merge promotion workflow. Manual and release runs retain their existing `origin/main` comparison. The canonical [Performance CI](../performance-ci.md#comparison-policy) contract defines the timing rules, all deterministic contracts, refresh profiles, and absolute reference-device budgets.

## Consequences

CI no longer resolves or measures a second source reference or maintains performance Git tags. Raw measurement artifacts retain their one-day lifetime. Existing historical tags, if any, are no longer read or updated by the gate.

A passing comparison is not proof of zero slowdown: finite measurement evidence and the existing relative margin can admit smaller regressions, which may accumulate across merges. Removing the historical comparison deliberately gives up that cumulative-drift check. Deterministic work/resource limits and absolute reference-device acceptance remain required.
