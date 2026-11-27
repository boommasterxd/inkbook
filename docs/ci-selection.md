# Affected Pull Request Verification

## Scope

Pull request checks run against GitHub's simulated merge result, and the pull request must be up to date with `main`. Selection uses the complete change set between the merge base of the pull request base SHA and head SHA. It includes both old and new paths for renames and includes deletions; it does not compare only the latest commit. The dependency graphs compare the merge-base snapshot with the checked-out simulated merge tree. The [CI workflow](../.github/workflows/ci.yml) keeps the required check names `CI`, `Performance (shared)`, and `Performance (refresh profiles)` unchanged.

A nonempty pull request whose changed paths are exclusively Markdown files under `docs/` is documentation-only. This path runs documentation validation, then skips application checks and npm installation while the required checks and final `CI` result still succeed. Root documentation changes such as `AGENTS.md` and `README.md` do not qualify for this fast path.

The regular quality gate starts with the same documentation validation on every non-documentation run, including mixed code/documentation changes and root `README.md` or `AGENTS.md` changes. Invalid documentation fails before application checks. Local `npm run ci:quality`, `npm run ci`, and release quality gates include this check; `npm run docs:check` runs it independently.

The [validator](../scripts/ci-documentation.mjs) checks the recursive index in [docs/README.md](README.md#documentation-index). It checks fences, relative Markdown and HTML link targets, and heading or explicit anchors in `docs/` Markdown and the root `AGENTS.md`, `README.md`, `CONTRIBUTING.md` and `SECURITY.md`. Verify the meaning and currency of edited links during the content review, including external destinations and anchors in other file types.

Every other pull request runs quality, dependency audit, production build, and package verification on the simulated merge result. The selector uses transitive TypeScript import graphs, including type-only edges, to choose tests from the merge-base and simulated-merge snapshots. Changed tests select themselves. Changes to shared test fixtures or helpers select their dependent tests.

## Selection and fallback

Selection binds four commit identities. `base` is the pull request base tip,
`head` is the pull request head, `mergeBase` is the origin of the complete
changed-path diff, and `merge` is the checked-out commit. Local selection needs
both requested commits. When `CI_MERGE` is supplied, it must match the exact
checkout. GitHub passes `github.sha` for that check. A revision mismatch fails.
The planner publishes workflow outputs without a selection plan file. Each active
consumer recomputes the plan once and validates `EXPECTED_MODE`,
`EXPECTED_SHARED`, and `EXPECTED_CADENCE` against the selection job's outputs.

- `docs` requires a validated, nonempty change set of Markdown paths under `docs/`.
- `affected` requires a complete comparison and at least one selected test across
  Unit, Integration, and the two performance contracts.
- `no-impact` requires a verified nonempty diff, complete base and merge-result
  dependency graphs, and no affected test after explicit mappings. Static quality,
  production audit, build, and package checks still run.
- `full` runs every critical test and performance profile. Use it for manual
  dispatch, removed tests, missing comparison history, empty comparisons,
  unresolved dependencies, and unknown or global changes. Changes to the central
  CI planner, command plan, test validation, performance harness, or manifest
  also select the full suite. Releases run the complete local commands.

Embedded worker, chrome, plugin, math, and import-gallery entry points use explicit
mappings. Recognized bundled font and license assets must resolve in both
snapshots and enter the graph as non-code leaves. The embedded WASM import must
resolve in the installed package. CSS and other non-code source changes
conservatively select all tests. Filesystem and dynamic loading boundaries need
explicit mappings. Uncertain relationships take the full fallback.

For non-documentation runs, selection installs dependencies and runs
`npm audit --omit=dev --audit-level=high` before quality and performance fan-out.
High or critical production findings and audit execution errors fail selection.
The hosted quality runner omits its duplicate audit only if
`EXPECTED_AUDIT=success` accompanies all matching selection outputs. Local
quality checks retain the audit. The final gate requires the documented
`skipped` audit outcome on the documentation-only path.

Every active quality run executes `npm ls --all`. Invalid or missing required
dependencies and incompatible peers fail. The same check runs in complete local
quality and release gates. CI uses isolated Unit and focused Integration tests
without browser, container, or external-service setup.

## Required secret scan

The independent [`gitleaks` job](../.github/workflows/gitleaks.yml) runs for pull requests targeting `main`, subject to GitHub's approval policy for external contributors. It scans the simulated merge worktree and the full `base..head` commit range with findings redacted. The scanner version, archive checksum, and rule configuration come from the exact PR base commit. The job verifies the archive before extracting it. Inkbook has no project-specific fingerprint or inline exceptions. The job disables inline suppressions and clears the runner checkout's root `.gitleaksignore` before scanning. Git history still covers changes to that file. GitHub uses the pull request's workflow definition, so edits to the workflow itself remain subject to review.

Manual dispatch uses the selected revision's scanner pin and rules and scans the worktree and history reachable from all fetched refs. The [version updater](../.github/workflows/update-gitleaks.yml) proposes a new pin for review. The proposed pin becomes active when it is part of a later scan's PR base or selected manual revision.

## Shared dependency cache

CI selection, quality, both performance shards, and releases use the same [dependency installation action](../.github/actions/install-dependencies/action.yml). Automatic `setup-node` caching is disabled. Only the npm content store at `~/.npm/_cacache` is transferred; credentials, npm logs, installed modules, and build output are excluded. Its versioned key binds runner OS/architecture, Node and npm major versions, `.npmrc`, and `package-lock.json`. A fallback can reuse another lockfile's downloads only within the same platform, tool, and install-configuration boundary. Runtime patch updates and unrelated source changes do not split the store.

Every consumer runs `npm ci --include=dev --prefer-offline --no-audit` with the same npm cache directory, regardless of restoration. Missing packages can still download normally. Cache transfers are best effort; installation and required checks remain blocking. The separate production audit remains required before CI fan-out. Documentation-only jobs and no-work performance jobs skip package restore and installation.

The repository's [npm configuration](../.npmrc) enables strict dependency lifecycle-script checking. Keep the explicit [package script policy](../package.json) alongside its lockfile: esbuild's approved setup may run, and the optional fsevents install hook is explicitly denied. An unclassified dependency hook fails installation instead of opening a default permission.

The [cache warmup](../.github/workflows/dependency-cache.yml) is the sole cache writer. It accepts only the verified default branch `main`, installs the complete root lockfile including development dependencies, and saves the content store after a successful install. Main-branch pushes affecting dependency manifests, runtime selectors, or cache/setup workflows refresh the store; ordinary source changes do not. There is no periodic refresh or duplicate quality/test/build pipeline. Consumers never save PR or tag caches into the shared store. Install hooks must remain reviewed and public packages must remain safe for fork PRs to read.

To seed or recover an evicted store after this workflow is available on `main`, explicitly dispatch `dependency-cache.yml` on `main`. Manual runs on other refs fail. Cache entries are immutable; a format or completeness correction requires a cache-schema version change. A successful restore proves neither package completeness nor faster installation.

The repository uses GitHub's [cache limits](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#usage-limits-and-eviction-policy) of seven days of inactivity and 10 GB of storage. This allows for ordinary gaps between runs and accommodates the active npm and CodeQL caches plus overlapping generations during rotation. After longer inactivity or eviction, use the existing warmup workflow. Reassess retention or storage when cache metadata shows recurring misses after expected gaps in use or pressure from active generations.

The operational target is at least 95% confirmed successful restores for unchanged compatible PR inputs after a successful trusted seed. Use the first 30 days after that seed as the observation window and count one opportunity for every active CI selection, quality, or performance install. Report the sample count, exact restores, confirmed compatible fallback restores, misses, service failures, and unknown outcomes from the native restore step outputs/logs. Exact and confirmed fallback restores form the numerator; all eligible opportunities, including unknown outcomes, form the denominator. Report initial seeding and dependency/setup-changing runs separately. Missing samples leave the target unverified; it is not a merge gate. Compare restore/install durations and total warmup overhead separately from wall time, summed runner time, and billed usage, without duplicate measurement installs.

The producer's follow-up cleanup runs after successful installation and cache post-save.
It retires only older compatible main generations with a uniquely identified nonempty
replacement. The metadata-only `cache-lifecycle.yml` also removes closed-PR caches once
associated runs finish, and retires replaced CodeQL snapshots per configuration and tool version. Current keys, open PRs, active consumers,
unknown families and unproven replacements remain protected. The project-owned policy
and portable GitHub plugin runtime in `scripts/cache-lifecycle` recheck main, cache versions,
PR state and active runs before deleting numeric cache IDs, cap each run at 100 deletions
and verify the remaining inventory. API failures preserve uncertain caches.

Deferred main rotation resumes on completion events using only a verified successful
main producer and its exact run attempt. An earlier main revision is accepted only
after a complete bounded ancestor comparison proves that all declared native key,
setup and install-hook inputs remain unchanged, including rename sources. Producer
input paths also trigger the warmup. Completion triggers include the GitHub-managed
CodeQL and Dependabot Updates workflows. Recovery considers at most 20 successful main runs, 100 commits and fewer
than 300 changed files. Missing or expired proof preserves caches until another
authorized warmup establishes a replacement. Its tiny
`cache-lifecycle-receipts-<attempt>` artifact contains only `replacements.json`, retained
for seven days and bounded to 64 KiB/20 identities. PR artifacts are never used.
Cleanup installs no dependencies and repeats no quality pipeline. Existing required gates,
cache retention/storage limits and the measurable 95% restore target remain independent.

## Test execution

The [validated test runner](../scripts/run-validated-tests.mjs) checks a fresh
Vitest report for the exact expected Unit and Integration files. Missing,
duplicate, malformed, failed, and unexpectedly skipped results fail the check.
The quality phase can have no Unit or Integration test selected when an affected
plan selects only a performance contract. The other quality checks still run.

The [performance manifest](../scripts/performance-test-manifest.mjs) assigns
bounded 10,000-stroke viewport publication to the shared check at 120 Hz, and
coalesced pen input to the refresh-profile check at 60, 90, 120, 144, and 240 Hz.
Select the affected contracts from the same graph. A full fallback runs both
complete checks. An inactive performance check returns success on Slim only when
selection validates that no contract applies.

The final required `CI` check requires successful selection and quality and the
correct result from both performance jobs for the current plan. Missing,
malformed, stale, failed, cancelled, or unexpectedly skipped output fails.
`npm test` and `npm run ci` retain complete local execution independent of PR
context and `CI=true`.

## Runner outputs and workflow fixtures

The planner publishes optional `GITHUB_OUTPUT` and `GITHUB_STEP_SUMMARY` data only to existing, owned, regular single-link files directly under the canonical `RUNNER_TEMP/_runner_file_commands` directory, using the runner's `set_output_` and `step_summary_` prefixes. It rejects external paths, redirected command directories, symlinks, hardlinks and file-identity changes before appending through the opened handle. `RUNNER_TEMP` is trusted runner configuration; this does not isolate a compromised runner. With both output variables absent, local planning needs no runner directory and continues to print its outputs to stdout.

## Local reproduction

Before merging, run `npm audit --include=dev` locally for the complete dependency
review. Dev-only findings do not automatically block merging. This separate local
review is not another CI audit/report step.

To reproduce a pull request plan locally, check out the simulated merge result containing the pull request base and head commits, export their SHAs, and set the event to `pull_request`. `CI_MERGE=<merge-sha>` is optional locally and requires that exact checkout when supplied. First print the plan and its `shared` and `cadence` outputs:

```sh
CI_BASE=<base-sha> CI_HEAD=<head-sha> CI_EVENT=pull_request node scripts/ci-plan.mjs
```

For an affected, no-impact, or full plan, run the quality runner. Run a performance runner only when the corresponding printed output is `true`; an intentional empty shard has no runner invocation. A documentation-only plan has no application runners. Each runner computes and validates its plan once from the checkout; it neither reads nor writes `.ci-selection.json` and needs no separate consumer planning command. Leave `EXPECTED_AUDIT` unset for local reproduction so the quality runner performs its own audit. Existing npm commands keep their full local behavior; `npm run ci`, `npm run ci:quality`, and `npm run benchmark` are not changed by pull request selection.

```sh
CI_BASE=<base-sha> CI_HEAD=<head-sha> CI_EVENT=pull_request node scripts/run-ci.mjs quality
CI_BASE=<base-sha> CI_HEAD=<head-sha> CI_EVENT=pull_request node scripts/run-ci.mjs shared  # only when shared=true
CI_BASE=<base-sha> CI_HEAD=<head-sha> CI_EVENT=pull_request node scripts/run-ci.mjs cadence # only when cadence=true
```
