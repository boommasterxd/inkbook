# Project Setup Report

## Assessment

Inkbook is partially conformant with the applicable local and public GitHub
baseline. Branch protection, affected-check selection, workflow isolation and
Node.js selectors are correctly configured. Required CI still fails on dependency
audit, and current main was merged using the administrator bypass. Secret Scanning
and Push Protection are now enabled; contributor approval matches the public
profile. CodeQL default setup and its initial Actions/JavaScript analysis passed.
The ten reported flows are corrected locally; a repeat of their three exact
CodeQL rules reports zero findings. Hosted alerts still refer to unchanged main.
Bundled third-party notices are preserved and verified in the working tree.
The local npm departure, a documentation filename and remaining acceptance gaps
prevent full conformance and release readiness.

## Target and scope

| Item                          | Inspected value                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| Review / baseline             | 2026-10-19; coding-tools 0.30.0, setup contract dated 2026-10-19                           |
| Repository                    | `boommasterxd/inkbook`, ID `1338357645`; origin and live target agree                      |
| Inspected commit / live main  | `b1ee4999ff020c3a5058ceddf6675ced3e7983e3`                                                 |
| Report branch                 | `codex/refresh-project-setup-report`, created from clean main                              |
| Requested / actual visibility | No transition requested; preserve current `public` / `public`; selected profile `public`   |
| Owner / plan                  | Personal account (`User`); plan and billed usage unavailable                               |
| Contribution policy           | `collaborators_only`, confirmed by REST and GraphQL; outside contributions are not enabled |
| License / package publication | Root MIT license, `license: MIT`; `private: true` prevents unintended npm publication      |
| Actual local runtime          | Node.js 24.22.0 / npm 12.2.0; existing installed dependencies                              |
| Hosted observed runtime       | Node.js 24.22.0 / bundled npm 11.19.1 in selection, quality and performance logs           |
| Authority                     | Review plus authorized security/contributor/attribution fixes and README refresh           |

Scope includes the local foundation, all six source workflows, their quality and
selection scripts, effective GitHub controls and existing run evidence. Global,
root and skill instructions, the complete previous setup report and code-quality
report were read. Two bounded Sol reviewers examined GitHub and local controls;
the main reviewer integrated and independently rechecked material findings.

Inkbook is a TypeScript/npm/esbuild Obsidian plugin with local SVG/settings
persistence. Next.js, Vercel, Turso, SMTP and public HTTP APIs are not applicable.
No hosting target or database is implied by local persistence. No visibility
transition or historical publication-exposure audit was requested. Follow-up
authority covers the three selected security/contributor/attribution corrections
and a README refresh based on the owner's Transcriber repository.

## Applied corrections

Secret Scanning and repository Push Protection were enabled through the repository
API and independently read back as `enabled`. Fork workflow approval now reads
`all_external_contributors`; PR creation remains `collaborators_only`.
CodeQL uses provider-managed default setup, the default query suite,
`remote_and_local` threat model and standard runners for JavaScript/TypeScript
and Actions. Its [initial setup run](https://github.com/boommasterxd/inkbook/actions/runs/39260053116)
passed both analyses on the existing main commit. Default-setup readback now
includes both language families and a weekly schedule, updated 2026-10-19 at
13:30:06 UTC. Both analyses are recorded against `refs/heads/main`.
No additional repository workflow or required-check name was introduced.
Secret Scanning reports zero open alerts. The initial CodeQL run labelled eight
workflow-test flows Critical and two `scripts/ci-plan.mjs` paths High. Static
review found runner-owned output paths and repository-owned workflow code rather
than ten proven exploitable application vulnerabilities. The requested local
corrections remove those sinks and tighten the relevant boundaries:

- `ci-runner-output.mjs` confines appends to existing, owned regular single-link
  runner command files, rejects redirected paths and checks opened-file identity.
- Workflow tests execute exclusive temporary script files instead of passing
  workflow contents to `bash -c`.
- Condition tests replace `runInNewContext` with a bounded TypeScript AST fixture
  that rejects calls, assignments, prototype access and unsupported syntax.

The three exact rules `js/path-injection`, `js/code-injection` and
`js/command-line-injection` now return zero results in a local CodeQL 2.27.2 /
JavaScript query pack 2.4.7 analysis. All 1,720 executable source files under
`src/`, `test/` and `scripts/` were extracted and compared with the working tree
through the database source archive; none was missing or different at analysis
time. Subsequent formatting of one test preserved its TypeScript AST.
This was a targeted three-rule repeat, not the full CodeQL query suite.
The ten hosted alerts refer to the inspected main commit until corrected source
is published and rescanned. No alert was dismissed or suppressed.

Root `LICENSE` now contains the full installed Meta MIT notice shared by React,
React DOM and Scheduler. The native build preserves the complete license as a
readable banner after production minification and in the watch configuration.
Package verification rejects missing or changed bundled notices and upstream
license drift. The distributable remains exactly `main.js`, `manifest.json` and
`styles.css`. Five isolated regressions and actual build/package checks pass.

The README now uses a local SVG banner, compact badges and navigation inspired by
[Transcriber](https://github.com/boommasterxd/transcriber), while retaining source
installation, release-candidate limits, local processing and contribution scope.
The restored GitHub automation section also repairs the existing README anchor.

## Findings

### GH-01: Dependency audit blocks CI; current main lacks successful CI

**Existing issue, still open.** The latest main-producing [PR 97](https://github.com/boommasterxd/inkbook/pull/97)
has a failed [CI run](https://github.com/boommasterxd/inkbook/actions/runs/39239768513).
Quality passed 634 files / 6,433 tests and coverage, then failed
`npm audit --audit-level=high` on seven related High reports in the
`braces` / `micromatch` / `fast-glob` / `globby` / Stylelint tooling chain.
The advisory is [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
These reports do not establish seven independent shipped-plugin vulnerabilities.
Build/package stages after audit did not execute; both performance shards passed
and final `CI` correctly failed.

Logs identify tested synthetic merge `073ae2c40e13e1b0a20aa76c36f69f10d71b0ef3`,
combining head `d47ab6b5eacba9ac3d179108dbb1ef3713d0a189` and base
`989babdbef36f140e179a219c2e3572a3bdd8d7a`. Its tree and current main's tree
are both `19e2aade647b36c67375bdfbbade4952b46e6114`.
PR 97 merged on 2026-10-19 at 12:38:09 UTC. Ruleset evaluation suite
`4599582679` records `bypass` and `Required status check "CI" is failing.`
Administrator-only bypass is intentional; actual use is not successful
verification or a standing audit waiver.

**Correction:** remediate the tooling chain through compatible maintained
dependencies and obtain successful current PR checks. Preserve audit severity,
strict checks and normal merge rules. A forced breaking Stylelint downgrade is
not a verified remedy.

### LOCAL-02: Local npm differs from the distribution baseline

**Existing environment departure.** Local Node.js 24.22.0 resolves npm 12.2.0.
The [official release index](https://nodejs.org/dist/index.json), checked again,
identifies 24.22.0 as latest 24.x and bundled npm 11.19.1. Observed hosted jobs use
the bundled pairing. No repository npm pin causes the mismatch.

**Correction:** use supported Node.js 24.x with bundled npm for subsequent
clean-install acceptance. No global tools were replaced; local checks do not
prove a fresh bundled-npm installation.

### DOC-01: Documentation filename violates the contract

`docs/reports/CODE-QUALITY-REPORT.md` departs from the required kebab-case
filenames. Rename it to `code-quality-report.md` and synchronize its root index
link in a later authorized correction.

## Control coverage

Statuses distinguish configuration from execution. A verified control does not
make the complete quality gate or release acceptance successful.

| Control                                                     | Status             | Expected/current behavior and evidence                                                                                                                    |
| ----------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native stack/layout/mirrored tests                          | verified           | Existing npm/TypeScript/esbuild plugin, five source areas and thin entry; no migration/scaffolder proof needed                                            |
| Architecture and worker isolation                           | verified           | Complete type-aware graph: 781 modules / 3,462 dependencies; ES2021/WebWorker entry typecheck                                                             |
| Instructions and initial documentation                      | verified           | Root instructions/README/SECURITY/CONTRIBUTING and normative architecture, operation, security and ADR coverage                                           |
| Recursive index, file links, fences and length              | verified           | All 38 docs indexed once in path order; validator passes; every document below 500 lines; fragment limitation in DOC-01                                   |
| Documentation filename                                      | drift              | DOC-01                                                                                                                                                    |
| Node selectors and engine enforcement                       | verified           | `engines.node: 24.x`, supported nvm alias `24`, `engine-strict=true`; latest 24.x resolves 24.22.0                                                        |
| Actual local npm                                            | drift              | LOCAL-02; hosted bundled pairing separately verified                                                                                                      |
| Lockfile / generated output                                 | verified           | npm lockfile v3; ignored dependencies/dist/coverage/caches/generated selection; no competing lockfile                                                     |
| Actual quality interfaces / failure propagation             | verified           | Command plan includes formatting, lint/styles/layout, architecture, types, coverage, jscpd, knip, audit, build/package; failures stop execution           |
| Complexity, size and Obsidian lint                          | verified           | Blocking errors: 100/500 function/file lines, 20/25 complexity/cognitive, six parameters, depth four; type-aware Obsidian configuration                   |
| Coverage thresholds                                         | verified           | 85% statements/lines/functions, 80% branches; full source or selected closure including affected untested modules; partial results labelled               |
| Duplication / unused-code gates                             | verified           | jscpd `minTokens: 50`, threshold 0%; ordinary and production-only Knip                                                                                    |
| Dependency audit result                                     | drift              | GH-01; current hosted failure and local result below                                                                                                      |
| Audit severity                                              | accepted-exception | Explicit project rule blocks High/Critical rather than template info; no GH-01 waiver                                                                     |
| App Router page/layout boundaries                           | not-applicable     | No Next.js App Router                                                                                                                                     |
| Initial server data / justified client fetching             | not-applicable     | No Server/Client Component architecture; Obsidian adapters own local access                                                                               |
| Blocking route/backend ESLint                               | not-applicable     | No App Router/backend; plugin boundaries enforced separately                                                                                              |
| WebP source / AVIF-first config / delivered formats         | not-applicable     | No Next.js image pipeline                                                                                                                                 |
| Identity, visibility, default branch                        | verified           | Public personal repository, main, origin/live target agreement; no requested visibility mismatch                                                          |
| Source license / public documentation                       | verified           | MIT source, installation README, contribution guide, private security-reporting email; bundled notices verified separately                                |
| PR creation / outside contributions                         | verified           | Collaborators-only policy preserved; external acceptance not applicable                                                                                   |
| Merge methods / squash metadata / features                  | verified           | Squash only; auto-merge/head deletion on, update suggestions off; COMMIT_OR_PR_TITLE / COMMIT_MESSAGES; Issues on, other listed features off              |
| Main ruleset / effective scope                              | verified           | Active 20986962, default branch, no exclusions; full details and effective rules read back                                                                |
| Deletion / force-push / PR / reviews                        | verified           | Block deletion/non-fast-forward; squash PR, zero approvals; no CODEOWNERS/last-push/stale-review/thread requirement                                       |
| Exact required names / source binding                       | verified           | CI, both named Performance contexts, gitleaks, Validate PR Title; no App binding                                                                          |
| Extra performance contexts                                  | accepted-exception | Explicit project instructions supplement generic three-check baseline                                                                                     |
| Fresh branches / creation checks                            | verified           | Strict checks true; do_not_enforce_on_create false                                                                                                        |
| Admin bypass configuration / use                            | verified           | Sole role 5 always; actual failing-CI use disclosed in GH-01                                                                                              |
| Unattributed-change approval                                | accepted-exception | Prior scoped decision retains require_extra_approval_for_unattributed_changes false                                                                       |
| Legacy / tag protection                                     | verified           | Main ruleset applies despite legacy API 404; active 20986966 protects numeric-style tags from deletion/update/non-fast-forward                            |
| Actions allowlist / SHA enforcement                         | verified           | GitHub-owned plus two external Actions; narrower allowlist retained; full-SHA enforcement true                                                            |
| Default token / PR-code isolation                           | verified           | Default read; code-bearing checks use pull_request without cloud secrets; guarded metadata-only Dependabot target event                                   |
| Public contributor approval                                 | verified           | all_external_contributors read back; private-only fork endpoint not applicable                                                                            |
| Secret Scanning / Push Protection / CodeQL                  | verified           | Secret Scanning/Push Protection enabled; CodeQL setup passed; local fixes yield zero results for all 3 original rules; hosted alerts await publication    |
| Scanner/workflow control review                             | unverified         | PR-modifiable controls; checksum proves integrity against supplied manifest; no external control-changing run/review evidence established                 |
| Private reporting route                                     | verified           | SECURITY private email; native private-reporting feature off, not required in addition to chosen route                                                    |
| Secrets/variables/environments/runners/keys/hooks           | verified           | Counts zero for Actions/Dependabot secrets, Actions variables, environments, self-hosted runners, deploy keys and hooks; no values read                   |
| Dependabot alerts / automatic fixes                         | verified           | Enabled, not paused; dependency labels exist                                                                                                              |
| Retention / OIDC                                            | verified           | Seven days, current public maximum 90; default immutable subject; no workflow requests OIDC                                                               |
| Owner plan / billing / Apps / automatic Copilot review      | unverified         | Plan omitted, billing unavailable, installation API requires App JWT, automatic review setting not established                                            |
| Five workflow roles / source action provenance              | verified           | Six source workflows including release; four full pins match upstream checkout 7.0.1, setup-node 7.1.0, semantic-pull-request 6.1.1, fetch-metadata 3.1.0 |
| All project-code Actions runtimes                           | verified           | Selection/quality/shards/release use 24.x and check-latest; no conflicting matrices/callers/containers; inspected logs resolve 24.22.0                    |
| Exact CI naming / final gate                                | verified           | Workflow/final check CI, required live; unconditional gate rejects failures/cancellation/unknown outputs and unexpected skips                             |
| Complete PR diff / tested merge                             | verified           | Merge-base-to-head, NUL paths, both rename paths/deletions; current synthetic merge tree equals main                                                      |
| Docs-only source behavior                                   | verified           | Nonempty root docs Markdown only; no npm install/application checks; documentation validation and real final gate; isolated regression cases              |
| Hosted docs-only behavior                                   | unverified         | No current execution established; no test PR/dispatch created                                                                                             |
| Affected scope / conservative fallback                      | verified           | Base/head AST/transitive/type/dynamic/embedded graph, explicit file-reader maps, broad styles/assets; unknown/empty/global/unmatched inputs fall back     |
| Selection consumers / coverage                              | verified           | Plans recomputed; stale/malformed/missing tests fail; selected-source thresholds maintained and scope reported partial                                    |
| Build selection / full local commands                       | verified           | Runtime/unknown inputs build; proven non-production inputs may omit build; ordinary full commands retain complete scope                                   |
| Scoped non-production adaptations                           | accepted-exception | Canonical CI contract permits mapped workflow/tooling tests and proven non-production full-test fallback without build                                    |
| Cancellation / caches / service setup                       | verified           | Superseded PR cancellation; npm download cache; no browsers/external services/cloud fixtures to install conditionally                                     |
| Duplicate automatic post-merge CI/Gitleaks                  | verified           | No current main-push/workflow-run repeat; historical workflow records do not establish active source; native tag release separate                         |
| Runner placement / timeouts                                 | verified           | Slim selection/final/title/Dependabot/scanner/updater; regular substantive quality/performance/release; Slim at most 15 minutes, quality/shards 20        |
| Hosted Slim selection/final/scanner/title                   | verified           | Full-plan cold-cache selector, scan/title success and correct final failure propagation                                                                   |
| Hosted Slim Dependabot/updater / admitted forks             | unverified         | Available active executions predate switch; human metadata paths skip; no new hosted fork evidence                                                        |
| Conventional title policy                                   | verified           | Expected types, optional scope and Dependabot actor exception; source/emitted check agree                                                                 |
| Dependabot scheduling / guarded auto-merge                  | verified           | Monday 08:00 Europe/Berlin, ten per ecosystem, minor/patch groups; actor/author/same-repo/nonfork checks; npm minor/patch only; isolated write job        |
| CodeMirror compatibility                                    | accepted-exception | Exact Obsidian 1.14.4 peers; state/view generic updates ignored; CodeMirror/Lezer external                                                                |
| Scanner version/checksum/rules/scope                        | verified           | Gitleaks 8.30.1, upstream checksum matches; built-in rules/redaction, tree plus introduced history; dispatch all-history path                             |
| Scanner updater                                             | verified           | Monthly/manual, serialized, strict release/checksum parsing, duplicate guards, fail-closed errors, normal PR/no auto-merge                                |
| Performance manifest / parity                               | verified           | 117 invariant files, 20 cadence files at five profiles; exhaustive classification; full local CI rejects shard-only overrides                             |
| Native tag release                                          | accepted-exception | Full quality/performance gate, numeric tag/manifest/main ancestry; substantive checks justify regular runner                                              |
| Bundled attribution                                         | verified           | Complete upstream notices in LICENSE and actual main.js; verifier/regressions pass                                                                        |
| Release / Community readiness                               | unverified         | No releases exist or were invoked; manual/hardware acceptance outstanding                                                                                 |
| Focused accessibility assertions                            | verified           | Blocking toolbar/canvas/panel cases cover roles/names, focus, keyboard and pressed/disabled state                                                         |
| Broader WCAG/manual accessibility                           | unverified         | No axe/rule engine or documented equivalent rule mapping; focused assertions do not establish WCAG 2.2 AA; real host acceptance not repeated              |
| Website production-server / E2E checks                      | not-applicable     | Obsidian host, no website server; explicit Unit/Integration-only project policy excludes E2E/smoke                                                        |
| Vercel settings/ownership/Git/runtime/deployment/usage/cost | not-applicable     | No Vercel target or hosted project configuration; no Function placement/cost attribution to assess                                                        |
| Turso/environment/migration controls                        | not-applicable     | Local SVG/settings persistence, no backend/cloud database                                                                                                 |
| SMTP / APIs / WAF / BotID / Bot Management / web CSP        | not-applicable     | No hosted HTTP application or public service                                                                                                              |

## Actual local verification

The full local `npm run ci` ran once with existing dependencies. Formatting,
ESLint, Stylelint, layout/scheduling boundaries, architecture and all three
TypeScript checks passed. The coverage stage failed: 631 files passed, two files
had three 5-second capacity-case timeouts, and one worker exited with SIGTRAP
while running `active-editor-handle-frames.test.ts`. The stack showed V8 failure
at `Object.freeze()` through `src/domain/store/immutability.ts`. Overall output
reported 6,424 passed tests, three failed tests and one unhandled worker error;
no complete coverage summary was produced.

The timeouts affected `uniform-spatial-index.test.ts` (two aggregate-membership
cases) and `element-store.test.ts` (incremental membership construction).
The default run admitted 32 workers on this host. A bounded repeat of only the
failed coverage stage through `npm run test:coverage -- --maxWorkers=4` passed all
634 files / 6,433 tests, preserving all files, assertions, deadlines and thresholds.
The three timeout cases and the SIGTRAP file passed. This does not establish the
cause or reliability of the default 32-worker path; that execution remains failed.
Static stages were not repeated. Full-project coverage passed:

| Metric     | Actual | Required |
| ---------- | -----: | -------: |
| Statements | 92.93% |      85% |
| Branches   | 88.11% |      80% |
| Functions  | 94.59% |      85% |
| Lines      | 95.46% |      85% |

Remaining stages continued through the native command-plan/exclusive-check runner,
individually retaining failures while completing subsequent checks. Duplication
(zero clones), both dead-code passes, production build and package verification
passed. Audit failed on the same seven related High reports described in GH-01.
Complete performance contracts passed: all 117 invariant files at 120 Hz and all
20 cadence-sensitive files at each of 60, 90, 120, 144 and 240 Hz. The continuation
runner correctly returned failure because audit failed. Neither continuations nor
the successful coverage repeat turn the original `npm run ci` into a passing run.

No install, dependency update, suppression, source fix, raised test deadline or
reduced fixture was used. Default-run reliability remains an evidence gap:
resource contention is plausible, but the V8 crash cause was not established.

The license/README follow-up passed all 17 tooling test files / 246 tests, including
the five new license cases, plus repository-wide formatting, ESLint, zero-clone
duplication, both Knip passes, native production build and package verification.
The complete selection graph still parses successfully after the new test:
1,721 files / 8,221 edges at that stage. Installed upstream license texts and the final readable
bundle banner match exactly. The SVG banner was rendered and visually inspected.
Watch configuration uses the same notice, but a watch process was not exercised.

Application runtime source and performance contracts were unchanged, so their
passing coverage and full performance evidence above was retained. This follow-up
does not claim another complete `npm run ci` or remove the known audit failure.

The subsequent CodeQL corrections add deterministic rejection cases for both
runner output variables, external/traversing paths, redirected command directories,
symlinks, hardlinks and unsupported condition syntax. Existing workflow gate,
Dependabot eligibility, checksum, Git-history and updater regressions retain their
actual shell behavior. Integrated verification passed all 18 tooling test files /
270 tests, repository-wide formatting and ESLint, zero-clone duplication and both
Knip passes. Documentation index, file links, fences and whitespace checks passed.
Current source/test/tooling graph construction succeeds with 1,724 files /
8,224 edges. The independent static review found no additional defect and checked
the output layout against the official runner implementation.

## Hosted evidence and resource assessment

The [current CI run](https://github.com/boommasterxd/inkbook/actions/runs/39239768513)
and associated checks provide these timestamp-based observations:

| Job                                                                                    | Runner        | Duration | Result                                   |
| -------------------------------------------------------------------------------------- | ------------- | -------: | ---------------------------------------- |
| Select affected checks                                                                 | ubuntu-slim   |     41 s | Success, cold npm cache, full selection  |
| Quality gates                                                                          | ubuntu-latest |    422 s | Audit failure                            |
| Performance (shared)                                                                   | ubuntu-latest |    660 s | Success                                  |
| Performance (refresh profiles)                                                         | ubuntu-latest |    332 s | Success                                  |
| CI                                                                                     | ubuntu-slim   |      3 s | Correct failure propagation              |
| [Gitleaks](https://github.com/boommasterxd/inkbook/actions/runs/39239768589)           | ubuntu-slim   |     16 s | Checksum/tree/introduced-history success |
| [Latest title check](https://github.com/boommasterxd/inkbook/actions/runs/39253529908) | ubuntu-slim   |      5 s | Success                                  |

Five CI jobs total 1,458 runner-seconds (24 minutes 18 seconds), versus
11 minutes 54 seconds workflow elapsed time. Per-job upward minute rounding
would give 27 minutes, an estimate rather than billed usage. Scope/cache
differences prevent attribution of changes against earlier runs to Slim.

Hosted coverage for the inspected committed tree is 92.93% statements, 88.11% branches,
94.59% functions and 95.47% lines. These stages do not make the failed aggregate
gate successful. Gitleaks covered the tree and one introduced commit; it does
not establish a new complete historical publication scan. Its
[published release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1)
Linux x64 checksum matches `.gitleaks-version`:
`551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`.
This verifies published pairing, not independent authenticity.

[GitHub runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
documents Slim's one CPU, 5 GB RAM, unprivileged container and 15-minute cap.
The observed selector leaves headroom, without guaranteeing future cold installs.
[Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
distinguishes free standard execution for public repositories from potential
storage/cache charges. Current inventories show 13 caches / 814,904,334 bytes and
zero artifacts; these are inventories, not accrued billing.

Account plan, billed usage and shared account capacity remain unavailable. Retain
the justified runner split, resolve blocking audit and observe remaining Slim
automation on ordinary authorized runs. No monetary saving is claimed.

## Verification limits

The main reviewer independently read identity/security metadata, public approval,
full/effective main rules, bypass suite, PR provenance, Actions policies and job
results. The local reviewer inspected actual selection/gate regressions and parsed
the exhaustive manifest and dependency graph: 117 invariant / 20 cadence files,
1,724 graph files / 8,224 edges after the CodeQL fixes. Parsing is not test execution.

The original draft received independent factual review. The root documentation
index validator still covers all 38 documents; no Markdown document was added or
renamed. README banner artwork was rendered at native size and visually inspected.
The restored `github-automation` anchor was checked separately because the existing
link validator does not validate fragments.
Independent follow-up review passed after correcting stale report text and graph
counts; it confirmed the final provider settings, both CodeQL analyses and the
complete license banner without an implementation defect in the scoped changes.

Authorized provider changes are listed above; local changes comprise README and
banner, LICENSE, build/package scripts, five regression cases and this report.
No application runtime source or dependency changed. The verification evidence
above was collected before publication. The owner subsequently authorized commit,
push, a normal pull request and an administrator-bypass squash merge to `main`,
including the known dependency-audit failure. This is a scoped publication
exception, not a passing CI result or a change to repository protection.
No manual workflow dispatch, release, deployment or live submission is included.
CodeQL initialization was the expected consequence of enabling default setup;
native scans may run again after publication.
The existing root index remains synchronized.

No Obsidian UI/hardware checks were repeated for these packaging/documentation changes.
Historical host evidence in the code-quality report is not fresh acceptance of
current artifacts. WCAG, physical pen/mobile, minimum-host and Community release
acceptance remain unverified. Use readback or normal authorized executions for
remaining hosted gaps, without manufacturing PRs or deployments for the review.
