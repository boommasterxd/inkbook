# Project Setup Report

## Assessment

Inkbook is partially conformant with the applicable local and GitHub standard.
Repository protection, workflow isolation, affected-check selection, Node.js
selectors, secret scanning and the observed Slim runner paths are correctly
configured. Seven high-severity dependency-audit reports still block local and
hosted CI. The latest merge used the intentional administrator bypass.
A minor departure concerns the local npm installation.
Full conformance and release readiness are not established.

## Target and scope

| Item                  | Inspected value                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Review / baseline     | 2026-10-19; coding-tools 0.29.11, setup contract dated 2026-10-19                                                                              |
| Local branch / commit | `codex/use-slim-ci-runners`; `d8b1da914d3ea7bcc5b2696b2919f7b221e58cca`                                                                        |
| GitHub target         | Private `boommasterxd/inkbook`, repository ID `1338357645`, default branch `main`                                                              |
| Live main             | `cd53b49233ae59b9a666a47551e41fda05603fe7`                                                                                                     |
| Source equality       | Both commits have tree `bc3271dd6fca1c55227734b0fe32ecd40b9d1046`                                                                              |
| Actual runtime        | Local Node.js 24.22.0 / npm 12.2.0; hosted inspected jobs 24.22.0 / npm 11.19.1                                                                |
| Authority             | Review and authorized documentation condensation; changes limited to this report, the quality document and its existing root index description |

Scope covers the local foundation, six workflows, quality/selection scripts,
effective GitHub policies and existing execution evidence. Applicable user/root
instructions, the complete previous report and skill references were read.
Current project contracts take precedence; valid prior exceptions remain visible.

Inkbook is a TypeScript Obsidian plugin with local SVG/settings persistence.
Next.js, Vercel, Turso, public APIs, SMTP, website CSP and image optimization are
not applicable. No provider resources or linkage were created.

## Findings

### GH-01: Dependency audit blocks CI; merged source lacks passing CI

**Existing issue, still open.** Ordinary merging requires successful current PR
checks. Both local `npm run ci` and hosted quality fail at
`npm audit --audit-level=high` with seven high reports in the
`braces` / `micromatch` / `fast-glob` / `globby` / Stylelint chain.
The advisory is [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
These are related dependency reports, not seven independently validated
exploitable vulnerabilities in the shipped plugin.

The [current CI run](https://github.com/boommasterxd/inkbook/actions/runs/39227808059)
tested synthetic merge `033384d`, combining head `d8b1da9` with base `0218b2e`.
All 6,417 tests, coverage, duplication and dead-code checks passed before audit.
Both performance shards passed; build/package stages after audit did not execute.
The unconditional final `CI` check correctly failed.

[PR 96](https://github.com/boommasterxd/inkbook/pull/96) nevertheless merged by
squash on 2026-10-19 at 09:18:41 UTC. Ruleset evaluation suite `4596512706`
records `result: bypass` and `Required status check "CI" is failing.`
The preceding selection change also used a bypass, recorded in suite
`4595296951` for PR 93. The administrator-only bypass is intentional and
correctly scoped; its use does not establish passing verification. The prior
explicitly authorized publication bypass is not a general audit waiver.

**Correction:** remediate the affected tooling dependencies through compatible,
maintained changes, then obtain successful current PR checks. Preserve the audit
threshold and protection rules. The suggested forced downgrade to Stylelint
7.7.0 is a breaking change, not a verified remedy. No dependency fix or new audit
exception was introduced during this review.

### LOCAL-02: Local npm differs from the Node.js distribution baseline

Expected: npm bundled with the selected Node.js release. The local Node.js
24.22.0 installation resolves npm 12.2.0; the
[official release index](https://nodejs.org/dist/index.json) records bundled npm
11.19.1. No repository npm pin causes this environment departure. Hosted selector,
quality and both performance jobs use 24.22.0 / 11.19.1.

**Correction:** use a supported Node.js 24.x installation with bundled npm for
subsequent clean-install acceptance. No global tools or dependencies were
replaced. The local results below do not prove a fresh bundled-npm installation.

## Control coverage

Statuses apply to the stated evidence layer, not to unperformed runtime checks.
Paths are repository-relative. `verified` does not mean the complete CI gate passed.

| Control                                                   | Status             | Expected/current behavior and evidence                                                                                                                                                          |
| --------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native stack, layout and mirrored tests                   | verified           | TypeScript/npm/esbuild Obsidian plugin; five source areas, thin `src/main.ts`, mirrored tests, README and normative docs                                                                        |
| Architecture and worker isolation                         | verified           | Dependency-cruiser/ESLint boundaries and entry-based ES2021/WebWorker typecheck; actual graph covers 780 modules and 3,457 dependencies                                                         |
| Instructions and initial technical documentation          | verified           | Root AGENTS/README/SECURITY/CONTRIBUTING plus focused architecture, development, security, release and ADR coverage in canonical topic docs                                                     |
| Recursive alphabetical index, relative links and fences   | verified           | All 37 Markdown documents indexed once; actual documentation validator passes                                                                                                                   |
| Documentation length                                      | verified           | All 37 documents contain fewer than 500 lines; quality-and-testing.md now has 499 lines with unchanged requirements                                                                             |
| Node selectors and engine enforcement                     | verified           | `engines.node: 24.x`, supported `.nvmrc` alias `24`, `engine-strict=true`; latest 24.x resolves 24.22.0                                                                                         |
| Actual local npm baseline                                 | drift              | LOCAL-02; hosted bundled npm is separately verified                                                                                                                                             |
| Lockfile, generated files and package manager             | verified           | npm lockfile v3; ignored dist/coverage/node_modules/generated selection/cache files; no competing package manager                                                                               |
| Actual quality interfaces and failure propagation         | verified           | Package scripts/check-command-plan/check-execution implement formatting, lint, styles/layout, architecture, types, coverage, jscpd, knip, audit, build/package gates; failures stop the group   |
| Complexity and size gates                                 | verified           | ESLint errors: 100 function lines, 500 file lines, complexity 20, cognitive complexity 25, six parameters, depth four; type-aware Obsidian rules blocking                                       |
| Coverage thresholds                                       | verified           | Vitest enforces 85% lines/statements/functions and 80% branches; full local/hosted results exceed each                                                                                          |
| Duplication and unused code                               | verified           | jscpd `minTokens: 50`, threshold 0%, actual zero clones; knip passes                                                                                                                            |
| Dependency-audit result                                   | drift              | GH-01; seven high reports block the configured gate                                                                                                                                             |
| Audit severity baseline                                   | accepted-exception | Explicit project rule blocks high rather than template info; current failure has no waiver                                                                                                      |
| App Router page/layout boundaries                         | not-applicable     | No Next.js App Router                                                                                                                                                                           |
| Server initial data / justified client fetching           | not-applicable     | No server/client component boundary; Obsidian adapters own local access                                                                                                                         |
| Blocking route/backend ESLint enforcement                 | not-applicable     | No App Router/backend; actual plugin boundaries checked separately                                                                                                                              |
| WebP source / AVIF-first optimization / delivered formats | not-applicable     | No Next.js website image pipeline                                                                                                                                                               |
| Repository identity, visibility and main                  | verified           | Live repository/branch APIs and local origin match                                                                                                                                              |
| Merge methods, auto-merge and PR creation                 | verified           | Squash only; auto-merge/head deletion enabled, update suggestions off, collaborators-only creation                                                                                              |
| Squash metadata and feature set                           | verified           | `COMMIT_OR_PR_TITLE` / `COMMIT_MESSAGES`; Issues on, Projects/Wiki/Discussions/Pages off                                                                                                        |
| Main ruleset and effective scope                          | verified           | Active `20986962`, default branch, no exclusions; full details and effective main rules inspected                                                                                               |
| Deletion/force-push and PR/review rules                   | verified           | Block deletion/non-fast-forward; squash PRs, zero approvals, no CODEOWNERS/last-push/stale-review/thread requirement                                                                            |
| Exact required checks and source binding                  | verified           | CI, both named Performance contexts, gitleaks, Validate PR Title; no App bindings                                                                                                               |
| Additional performance requirements                       | accepted-exception | Explicit project instructions supplement generic three-check baseline                                                                                                                           |
| Strict up-to-date branches and creation enforcement       | verified           | Strict checks true; `do_not_enforce_on_create: false`                                                                                                                                           |
| Bypass configuration / actual use                         | verified           | Sole admin role 5, always; failing-CI use separately reported in GH-01                                                                                                                          |
| Unattributed Copilot approval                             | accepted-exception | Prior explicit decision retains false; zero required approvals                                                                                                                                  |
| Legacy/tag protection                                     | verified           | Legacy API has no protection; main ruleset applies; active tag ruleset `20986966` blocks deletion/update/non-fast-forward                                                                       |
| Actions allowlist and SHA enforcement                     | verified           | Enabled, full-SHA enforcement true; GitHub-owned plus two external Actions, narrower allowlist retained                                                                                         |
| Default token and private fork policy                     | verified           | Default read; Actions PR creation allowed; fork approval required, no fork writes/secrets/variables                                                                                             |
| Self-hosted runners, keys and hooks                       | verified           | Dedicated lists/counts empty                                                                                                                                                                    |
| Actions/Dependabot secrets, variables, environments       | verified           | Counts/lists empty; no secret values requested                                                                                                                                                  |
| Dependabot security / native scanning                     | verified           | Alerts on, fixes enabled/not paused; APIs explicitly report Code/Secret Scanning disabled; no assigned Code Security configuration                                                              |
| Retention / OIDC                                          | verified           | Seven days permitted; default immutable OIDC subject; no workflow requests token                                                                                                                |
| Plan, Apps, push protection, automatic Copilot review     | unverified         | Plan omitted, installation API inaccessible; remaining dashboard/account controls not established                                                                                               |
| Workflow roles and upstream action pins                   | verified           | Five baseline roles plus native release; all four pins match official version-tag commits                                                                                                       |
| Every Actions project-code runtime                        | verified           | Selector/quality/performance/release select 24.x with check-latest; no conflicting containers, matrices or reusable callers; existing selector/quality/shard logs resolve 24.22.0               |
| CI naming and final aggregation                           | verified           | Workflow and final check exactly CI; unconditional gate rejects failed/cancelled/skipped prerequisites and malformed outputs                                                                    |
| Complete PR diff / tested checkout                        | verified           | Merge-base-to-head, NUL filenames, both rename paths/deletions; current synthetic merge checkout confirmed                                                                                      |
| Docs-only short path                                      | verified           | Nonempty Markdown-only root docs diff; no install/application work; documentation validation and final gate required; isolated CLI/gate regressions pass                                        |
| Affected checks / conservative fallback                   | verified           | Base/head AST graphs include transitive/type-only/dynamic/embedded edges; styles/assets select broadly; workflow file readers map explicitly; uncertain/empty/global/unmatched scope falls back |
| Partial coverage and plan validation                      | verified           | Same thresholds on forward runtime closure plus affected modules, including untested sources; labelled partial; consumers recompute/compare plans; unexpected empty tests fail                  |
| Build selection and full local interfaces                 | verified           | Production/dependency/unknown paths build; proven tooling/test/docs-only input omits build; manual/release/local full suites preserved                                                          |
| Selection failure regressions                             | verified           | Actual selected Vitest failure, excluded unrelated tests, stale/malformed plans, history/renames/deletions and actual final-gate shell exercised                                                |
| Scoped selection adaptations                              | accepted-exception | Canonical ci-selection contract permits mapped workflow/tooling tests and proven non-production full-test fallback without build                                                                |
| Cancellation, caches, fixtures and browsers               | verified           | PR-scoped cancellation, npm download cache; no secret-bearing/compiler cache, browser installs or external services to condition                                                                |
| PR-only CI/scanner and post-merge duplication             | verified           | Main-target PRs plus manual dispatch; no current main-push/workflow-run repeat path; existing main-push history shows no current duplicate CI/scanner execution                                 |
| Runner placement and timeouts                             | verified           | Slim for selection/final/title/Dependabot/scanner/updater; regular quality/performance/release; Slim at most 15 minutes, quality/shards 20 minutes                                              |
| Hosted Slim selection/final/scanner/title                 | verified           | Full-plan cold-cache selector succeeds; final gate propagates audit failure; checksum/tree/history scan and title succeed                                                                       |
| Hosted Slim Dependabot/updater branches                   | unverified         | Available active paths predate runner change; human PR skips Dependabot; no dispatch/update PR created                                                                                          |
| Conventional title policy                                 | verified           | Expected types, optional scope, intentional Dependabot actor exception; source/current check agree                                                                                              |
| Dependabot schedule/groups/labels/limits                  | verified           | Monday 08:00 Europe/Berlin, ten PRs per ecosystem, minor/patch groups, required labels exist                                                                                                    |
| CodeMirror compatibility policy                           | accepted-exception | State/view updates ignored; pinned peers match Obsidian 1.14.4 and stay external with Lezer                                                                                                     |
| Dependabot isolation/eligibility                          | verified           | Metadata-only target event; actor/author/same-repository/nonfork guards; npm minor/patch only; only merge job writes; historical success/major-skip evidence                                    |
| Scanner version/checksum/rules/scope                      | verified           | Latest Gitleaks 8.30.1, upstream Linux x64 checksum matches; built-in rules/redaction, tree and introduced history; manual all-history path                                                     |
| Scanner updater source controls                           | verified           | Monthly day one 06:00 UTC/manual; duplicate branch/PR guards, fail-closed errors, exact tag/checksum, serialization, ten-minute timeout, normal PR/no auto-merge                                |
| Deterministic performance and parity                      | verified           | Exhaustive manifest: 116 invariant files at 120 Hz, 20 cadence files at all five rates; no elapsed-time acceptance; local CI rejects shard-only overrides                                       |
| Native release policy                                     | accepted-exception | Tag-only full gate, numeric tag/manifest/main ancestry; substantive build/test work justifies regular runner                                                                                    |
| Current release / Community readiness                     | unverified         | No release invoked; private UNLICENSED state and missing distribution license documented; no submission-ready claim                                                                             |
| Accessibility and keyboard assertions                     | verified           | Focused toolbar/canvas/panel/keyboard Unit/Integration checks are blocking and pass; manual/physical host acceptance remains separate                                                           |
| Website production-server/E2E extensions                  | not-applicable     | No native website server; project explicitly requires Unit/focused Integration, excludes E2E/smoke                                                                                              |
| Vercel config/deployment/runtime/usage/cost               | not-applicable     | No hosted target selected; no provider configuration inferred                                                                                                                                   |
| Turso/migrations/SMTP/public API/BotID/WAF/web CSP        | not-applicable     | Local SVG/settings persistence; no application backend, database or public service                                                                                                              |

## Actual verification

The complete local `npm run ci` ran once against existing dependencies.
Formatting, ESLint, Stylelint, layout/scheduling boundaries, architecture,
runtime/test/worker typechecks, all 631 Unit/Integration files and 6,417 tests,
coverage, duplication and dead-code checks passed. Audit then failed as described
in GH-01. No install, dependency update or suppression was performed.

| Full-project coverage | Actual | Required |
| --------------------- | ------ | -------- |
| Statements            | 92.92% | 85%      |
| Branches              | 88.08% | 80%      |
| Functions             | 94.54% | 85%      |
| Lines                 | 95.45% | 85%      |

Remaining stages were continued separately: `npm run build` and
`npm run package:verify` passed. The complete `npm run benchmark` also passed:
116 invariant files at 120 Hz and all 20 cadence-sensitive files at each of
60, 90, 120, 144 and 240 Hz. Continuations do not change the overall failed CI.

The final report received a separate factual review. Its formatting and whitespace,
all 37 index entries, relative links and Markdown fences were checked successfully.
Only documentation edits followed the application checks, so their passing evidence
was retained without repeating unaffected suites. The authorized condensation of
quality priorities preserves every requirement and reduces that document to 499 lines.

A separate bounded reviewer collected live GitHub evidence. The main reviewer
independently rechecked active rules, SHA enforcement, current main tree, CI job
results and bypass evaluation. All four action pins match upstream:
checkout 7.0.1, setup-node 7.1.0, semantic-pull-request 6.1.1 and fetch-metadata
3.1.0. [Gitleaks 8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1)
has published Linux x64 checksum
`551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`.
That verifies published pairing, not independent authenticity.

Read-only GitHub queries used explicit targets, full/effective rules,
count-only secret metadata, existing PR/check/job records and filtered logs.
No provider settings, source, workflows, tests or dependencies changed. No
dispatch, test PR, merge, release, deployment or live submission was triggered.
No Obsidian UI/hardware acceptance was repeated for this report. Isolated mocks
do not establish unobserved provider branches or manual host behavior.

## Hosted runner evidence and resource assessment

The [current CI run](https://github.com/boommasterxd/inkbook/actions/runs/39227808059)
and associated scanner/title checks provide these observed durations:

| Job                            | Runner        | Duration    | Result                                        |
| ------------------------------ | ------------- | ----------- | --------------------------------------------- |
| Select affected checks         | ubuntu-slim   | 72 seconds  | Success, cold npm cache, full planner         |
| Quality gates                  | ubuntu-latest | 412 seconds | Audit failure                                 |
| Performance (shared)           | ubuntu-latest | 519 seconds | Success                                       |
| Performance (refresh profiles) | ubuntu-latest | 368 seconds | Success                                       |
| CI                             | ubuntu-slim   | 5 seconds   | Correct failure propagation                   |
| gitleaks                       | ubuntu-slim   | 13 seconds  | Checksum, tree and introduced-history success |
| Validate PR Title              | ubuntu-slim   | 6 seconds   | Success                                       |

The five CI jobs total 1,376 runner-seconds (22 minutes 56 seconds), versus
10 minutes 11 seconds workflow wall time. Rounding each job upward separately
gives 25 estimated runner-minutes from timestamps, not actual billed usage.
The [preceding CI run](https://github.com/boommasterxd/inkbook/actions/runs/39218147036)
totaled 23 minutes 46 seconds with 11 minutes 30 seconds elapsed.
Different scope/cache/execution conditions prevent attributing the difference
to Slim.

[GitHub runner limits](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#single-cpu-runners)
confirm one CPU, 5 GB RAM, unprivileged containers and the hard 15-minute limit.
The [Slim tool inventory](https://github.com/actions/runner-images/blob/main/images/ubuntu-slim/ubuntu-slim-Readme.md)
and actual image `20261012.23.1` logs support required Git, shell, jq, gh, curl,
archive and checksum tools. The 72-second selector leaves observed headroom,
without guaranteeing future cold-install duration.

Actual billed usage, allowance and account plan are unavailable; the billing
endpoint returned 404 and requires additional user scope.
[Current runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)
alone cannot prove savings for this private repository. Retain the runner split,
inspect remaining Slim automation paths on their next normal authorized runs,
and resolve the audit failure. No measured monetary savings are claimed.

## Remaining evidence gaps

Full conformance remains blocked by GH-01 and the local npm departure.
Account plan/billing, installed Apps, push protection and automatic Copilot
review remain unverified. Hosted Slim Dependabot/updater paths, a hosted
docs-only execution and a current release were not newly exercised. Isolated
regressions establish source selection behavior, not every hosted branch.
Use readback or the next ordinary authorized run; test PRs, dispatches,
Previews and releases are not audit prerequisites.
