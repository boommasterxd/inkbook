# Code Quality Report

## Assessment

The three recovery findings CQ-01–03 are fixed in the working tree and covered by
regression tests. Recovery preserves foreign or unproven files, rejects stale
readback through Markdown completion, and closes export receipts on their producing
executor. Independent review also reproduced and closed the creation-time race in
which foreign bytes arrive before `Vault.create()` resolves.

The known dependency-audit issue GH-01 and local npm departure LOCAL-02 remain.
No additional current defect was confirmed in the bounded follow-up review.
Full CI and release readiness must not be inferred from passing individual stages.

## Scope and Checks

Initial review and follow-up implementation: 2026-10-19. The unchanged commit base
is `d8b1da914d3ea7bcc5b2696b2919f7b221e58cca`; implementation is uncommitted on
`codex/public-readme`. Existing unrelated documentation edits were preserved.
No commit, push, PR, merge, provider change or release was performed.

Inkbook is a TypeScript/esbuild Obsidian plugin using API package 1.14.4, minimum
host 1.13.0, React 19.3.0, TypeScript 5.9.3 and Vitest 5.0.3. Supported targets are
desktop, iOS and Android. Actual local checks use Linux, Node.js 24.22.0 and npm
12.2.0 with existing installed dependencies, without a fresh installation.

The initial review inspected source responsibilities and representative runtime
flows across domain, editor, rendering, persistence and Obsidian; all six workflows,
their called commands and effective gates; and the complete previous setup report.
The follow-up concentrates on recovery creation, file identity/content, readback,
session retention, executor retries and export ownership. Generated output, caches
and vendored code are excluded from source findings. This is not an exhaustive
line-by-line or security review.

| Follow-up verification                                 | Actual result                                                                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Full local gate through `npm run ci` and continuations | Static/architecture/type, tests/coverage, duplication, dead-code and package stages passed; audit still fails at GH-01 |
| Unit/Integration and full-project coverage             | 634 files / 6,433 tests passed; 92.93% statements, 88.11% branches, 94.59% functions, 95.47% lines                     |
| Production build and package contract                  | Both passed                                                                                                            |
| Complete performance contracts                         | Passed: 117 invariant files at 120 Hz and all 20 cadence files at each of 60/90/120/144/240 Hz                         |
| Focused regressions and independent review             | Recovery, worker-origin and 64-MiB comparison checks passed; independent code/report review incorporated               |

The single full gate run passed through coverage, then detected two repeated
assertion blocks in the new integrity tests. Those assertions were shared without
removing cases or checks; the affected eight tests, their ESLint check and full
duplication check passed afterward. Dead-code, audit, build, package and performance
stages were continued separately without repeating unaffected passing stages.
Production source did not change after the full coverage run. The aggregate gate
remains failed because the separate audit again reports seven High entries.

Architecture verified 781 modules and 3,462 dependency edges with no violation.

## Quality Gates

The configurations remain blocking. The only performance configuration change
registers the new readback-comparison resource contract in the existing invariant
manifest.

| Check / scope              | Required and effective behavior                                                  | Evidence / outcome                                                            |
| -------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Type-aware lint / Obsidian | Errors and zero warnings                                                         | `eslint.config.mjs`, native command plan                                      |
| Size and complexity        | Function/file 100/500 lines; cyclomatic/cognitive 20/25; parameters 6; depth 4   | Blocking ESLint; review triggers are not automatic defects                    |
| Architecture / Scene       | Complete acyclic graph, area directions, imperative Scene                        | Dependency-cruiser, ESLint and layout gate                                    |
| Worker isolation           | ES2021/WebWorker without DOM/React/Obsidian                                      | Entry-based worker typecheck                                                  |
| Coverage                   | Statements/lines/functions ≥85%; branches ≥80%                                   | Vitest thresholds; selected PRs retain them over their stated runtime closure |
| Duplication                | `minTokens: 50`; effective threshold 0%, stricter than the 5% maximum            | jscpd                                                                         |
| Dead code                  | Fatal ordinary and production-only checks                                        | Both Knip passes                                                              |
| Audit                      | High/Critical failures block                                                     | `npm audit --audit-level=high`; GH-01 remains open                            |
| Package                    | Native production build and release-artifact verification                        | Build/package scripts                                                         |
| Performance                | Exhaustive invariant and five-profile contracts; fail closed                     | Manifest, batch runner and result parser                                      |
| PR selection               | Complete merge-base-to-head diff, rename/deletion support, conservative fallback | Selection graph/plan and execution regressions                                |
| Required checks            | Exact five names, strict current branch, squash-only                             | Initial live effective-main/ruleset `20986962` readback; no provider changes  |
| Runners / Node             | Slim coordination; regular quality/performance/release; latest 24.x selectors    | SHA pins, `check-latest: true`, Slim ≤15 minutes, quality/shards ≤20 minutes  |
| Accessibility              | Focused plugin Unit/Integration contracts                                        | Toolbar/canvas/panel coverage; full manual acceptance remains separate        |

Required checks remain `CI`, `Performance (shared)`,
`Performance (refresh profiles)`, `gitleaks` and `Validate PR Title`.
Workflow and final gate are named `CI`. Explicit documentation-only and valid empty
selected-shard paths succeed; unexpected failed, missing, skipped, cancelled or
malformed applicable work fails closed. Selected coverage is partial coverage.

The inspected [CI run 39227808059](https://github.com/boommasterxd/inkbook/actions/runs/39227808059)
failed audit and final CI while both performance shards passed. The intentional
administrator-only bypass remains a scoped prior decision, not an audit waiver.
No new hosted execution was triggered.

## Recovery Findings Resolved in the Working Tree

### CQ-01 · Resolved P1 · Cleanup ownership

Previously, recovery selected a free path before asynchronous export. A creation
collision could cause the catch block to resolve and trash another writer's file.
A second race allowed changes to the successfully created file before the create
promise resolved, so metadata captured afterward could incorrectly attest foreign
bytes, even at identical length and unchanged stats.

`src/obsidian/vault/file-adapter.ts` now returns the exact created file, creation
receipt and guarded readback through `createOwnedAndReadBack()`. Recovery never
derives ownership from resolving a path after failure. Before permitting cleanup,
`saveRecoveryCopy()` compares the complete readback against its own export and
checks both guards around the comparison. Only an unchanged, byte-proven artifact
can reach `FileManager.trashFile()`.

Unreadable, mismatched or externally changed copies remain untouched and recovery
fails. This deliberately preserves an unverified artifact after a failed host read
or disposal that prevents byte comparison. The older unsafe expectations that
unverified copies must always be deleted were corrected. Proven unchanged copies
retain their cancellation and stale-operation cleanup coverage.

Regression cases use the real session factory, adapter and document runtime:
collision during export; changes before create resolution with different or
identical length/stats; replacement during a failed host read; and read failure
with retained original dirty state. Independent review additionally exercised
modification and replacement during scheduler admission.

The exact comparison reuses the existing 262,144-code-unit chunk boundary through the injected
central `WorkScheduler`. Its invariant performance test observes actual string
slice reads with a full-capacity 64-MiB ASCII fixture: each UTF-16 code unit read
once per side, at most 262,144 code units per slice,
no forced handoff while admission remains available, early mismatch/length exit,
and no further reads after scheduler rejection.

### CQ-02 · Resolved P1 · Readback remains current through completion

Previously, worker verification received only the earlier read bytes. An external
change during verification could still produce a confirmed recovery and Markdown
replacement, allowing the coordinator to release the last dirty original.

`src/obsidian/embeds/vault-document-recovery.ts` retains the guarded readback and
creation receipt. Both remain authoritative before and after asynchronous
verification, before and after the completion callback, and inside the Markdown
replacement predicate. A stale result is failed, preserves the changed file and
does not release the dirty session.

Regression cases modify or replace the real adapter's file while verification is
held, and invalidate the file during Markdown replacement. Assertions check no
confirmation, no inappropriate Markdown update or trash, identical retained dirty
model, and no runtime termination. The subsequent coordinator release consequence
is covered by existing coordinator contracts and source tracing, rather than an
additional complete coordinator/host race reproduction.

### CQ-03 · Resolved P2 · Export acknowledgement lifetime

Previously, recovery exports and baseline restoration left successful export
receipts open. The native bridge could retain complete wire output and the fallback
runtime's one outstanding export could block speculative prewarming on a retained
session. Terminal successful recovery already disposed its executor.

`src/obsidian/embeds/vault-recovery-export.ts` closes each successful export in
`finally` once decoded output is caller-owned, before downstream validation or host
I/O. These operations do not accept an autosave generation and acknowledge with
`accepted: false`. The wrapper in `vault-recovery-executor.ts` forwards that call
to the captured producing executor even if the current executor/epoch changes.

Unit cases cover cancellation, replacement, retry, downstream validation failure,
typed export failure and ports without optional acknowledgement. Native bridge and
baseline-restoration integration cases assert the exact protocol acknowledgement,
zero real runtime outstanding exports, retained decoded output, and no forgotten
receipt requiring another acknowledgement at termination. No measured speed or
unbounded fallback-memory claim is made.

Independent review found no remaining CQ-01–03 defect after targeted real-adapter
and runtime checks. The initial negative diagnostics were separate temporary tests;
the maintained regressions now assert the corrected behavior.

## Existing Findings and Decisions

**GH-01 remains open.** The installed Stylelint development dependency chain includes
`micromatch@4.0.8` and `braces@3.0.3`; the audit reports seven connected High
dependency entries. [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
applies to the installed Braces version. These are not seven independently
demonstrated shipped-plugin vulnerabilities: source and build entrypoints do not
import that development chain. Compatible remediation and successful current CI
remain necessary; npm's proposed breaking Stylelint downgrade is not a verified
remedy. This task did not change dependencies or weaken audit.

**LOCAL-02 remains an environment departure.** Local Node.js 24.22.0 uses npm 12.2.0;
the [official Node.js distribution index](https://nodejs.org/dist/index.json)
records bundled npm 11.19.1. No repository npm pin causes this. Future clean-install
acceptance should use Node 24.x with bundled npm; no global tools were replaced.

Still-applicable decisions remain: deterministic work/resource and simulated
scheduling contracts rather than speed comparisons; Unit/focused Integration
rather than E2E/smoke; the isolated read-only hotkey gateway; CodeMirror peer pins;
React-owned chrome with imperative Scene; High audit threshold; two performance
shards with five cadence profiles; validated non-production build omissions; and
the documented public-host concurrency limits.

The recovery ownership and safe artifact-retention contract is recorded in
[Specification](../specification.md#workspace-activation-and-detachment);
worker acknowledgement ownership is recorded in
[Rendering and Performance](../rendering-and-performance.md#document-worker-autosave-and-export).
No separate competing contract was created.

## Host Evidence and Limitations

The initial review ran the production plugin in headed Flatpak Obsidian 1.14.4
under a dedicated 1920 × 1200 X11 display with GPU disabled, using an isolated QA
vault copy. These baseline artifact hashes predate the fixes:

| Artifact        | Baseline SHA-256                                                   |
| --------------- | ------------------------------------------------------------------ |
| `main.js`       | `21dfc2dfb35eb068d2e6189d20aeabba9c933656817e85dad49c70d60981ac57` |
| `manifest.json` | `b34b2f67a2e4e504fe0f571751b7531684806a41ace40249d86bedce7cd89157` |
| `styles.css`    | `7a4419ca9301fe2552a16cca39deb690439346245fc705aa2febc5bb3c6f4f45` |

The two-stroke fixture passed normal drawing, Undo/Redo, Overflow/Escape, canvas
focus and lock/save/reopen in desktop 1920 × 1168, tablet 1920 × 1168 with
`is-mobile is-tablet`, and phone 360 × 800 with `is-mobile is-phone`.
The phone menu stayed inside `visualViewport` at both 800- and 500-pixel heights.
Desktop Reading view passed activation/relock and plugin disable/enable/remount;
the settings tab rendered. Main-page error/rejection collections were empty.
Owned processes and copied vault/profile state were cleaned up, with the original
QA vault and theme unchanged.

Those checks are baseline host evidence, not execution of the new recovery paths
against the updated artifacts. No new real Obsidian concurrent-writer failure,
physical mobile/pen, clipboard permission, full multi-window, dark/high-contrast,
external SVG editor or device latency/memory acceptance was performed. Settings
editing and the independent settings-window error stream were not checked.

Public Obsidian file identity, metadata and modification epochs detect observed
races; `FileManager.trashFile()` offers no atomic compare-and-trash transaction
against another process. The fix does not promise an atomic filesystem lock.
Unknown artifacts are preserved rather than claimed to be confirmed or safely owned.

No fresh install, release, Community submission or new hosted run was performed.
Account/billing, docs-only hosted execution and remaining Slim automation branches
were not newly established. Lighthouse, Next.js/Vercel and website CSP are not
applicable. This report does not claim complete security, accessibility, hardware
acceptance or release readiness.
