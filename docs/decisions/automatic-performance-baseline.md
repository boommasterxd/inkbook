# Automatic Performance Baseline

## Status

Accepted, 2026-09-16. Hosted activation and timing must be verified after this workflow reaches `main`.

## Context

A fixed historical source anchor can lose the protection gained from later optimizations. Updating it after every passing PR would instead normalize allowed regressions. Long-lived raw measurement artifacts and additional benchmark runs are unnecessary for retaining an improved source reference.

## Decision

Use a moving Git tag for the baseline, resolved to one immutable SHA per CI run. Promote only already merged, exactly tested trees meeting the stricter [automatic promotion contract](../performance-ci.md#automatic-reference-promotion). Reuse the first six existing measurement pairs; no new samples or benchmark stages are added. Every measured metric must be no worse and at least one must improve; skipped areas require existing identity proofs.

Run publication in a short, serialized post-merge workflow. Validate the completed PR checks, artifact provenance, full metric populations, tested tree, and current reference before an atomic compare-and-swap update. Execute only merged repository tooling; treat downloaded artifacts as bounded data. This follows GitHub's [secure use guidance](https://docs.github.com/en/actions/reference/security/secure-use).

Keep raw and handoff artifacts for one day. Persist a compact promotion audit with metric evidence in an immutable annotated Git tag, separate from the moving source tag. No metadata-only commit on `main` is needed. GitHub documents [annotated tag objects](https://docs.github.com/en/rest/git/tags); promotion publishes the audit and baseline references together through Git.

## Consequences

The benchmark count, sampling schedule, required checks, and regression thresholds remain unchanged. CI adds reference resolution, compact report handling, and a post-merge Git/API job. Its hosted wall-clock overhead is not established by local tests.

Conservative evidence often retains an older baseline: one noisy, slower, missing, or incompatible measured metric blocks replacement. Exact ties are allowed alongside at least one strict improvement. A statistically supported improvement is not a guarantee about every workload or future run. The full limitations and acceptance rule remain canonical in Performance CI.

Expired artifacts or stale decisions do not trigger additional measurements. Repository tag permissions are an operational prerequisite. Activation does not alter repository rules or authorize a push or merge from a local implementation task.
