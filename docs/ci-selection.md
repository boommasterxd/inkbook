# Affected Pull Request Verification

## Scope

Pull request checks run against GitHub's simulated merge result, and the pull request must be up to date with `main`. Selection uses the complete change set between the merge base of the pull request base SHA and head SHA. It includes both old and new paths for renames and includes deletions; it does not compare only the latest commit. The dependency graphs compare the merge-base snapshot with the checked-out simulated merge tree. The [CI workflow](../.github/workflows/ci.yml) keeps the required check names `CI`, `Performance (shared)`, and `Performance (refresh profiles)` unchanged.

A nonempty pull request whose changed paths are exclusively Markdown files under `docs/` is documentation-only. This path validates the documentation index, relative links, and Markdown fences, then skips application checks and npm installation while the required checks and final `CI` result still succeed. Root documentation changes such as `AGENTS.md` and `README.md` do not qualify for this fast path.

The regular quality gate starts with the same documentation validation for every affected or full run, including mixed code/documentation changes and root `README.md` or `AGENTS.md` changes. Invalid documentation fails before application checks. Local `npm run ci:quality`, `npm run ci`, and release quality gates include this check; `npm run docs:check` runs it independently.

Other pull requests run the checks affected by their changes on the simulated merge result. The selector uses the transitive TypeScript AST import graph, including type-only edges, to connect runtime files and tests across the base and merge-result snapshots. Changed tests select themselves. Changes to shared test fixtures or helpers select their dependent tests. A reliable production-input classification determines whether build and package checks are needed.

## Selection and fallback

Selection plans use format version 2 and retain four separate commit identities: `base` is the actual pull request base tip, `head` is the pull request head, `mergeBase` is the origin of the complete changed-path diff, and `merge` is the checked-out commit. Before selection, the checkout must contain both requested base and head commits. When `CI_MERGE` is supplied, the checkout must also match that exact commit; hosted CI binds it to `github.sha`. An identity mismatch fails instead of falling back to tests against an unrelated tree. Selection publishes workflow outputs without writing a plan file. Each active application runner computes its own plan once in memory and compares `EXPECTED_MODE`, `EXPECTED_SHARED`, `EXPECTED_CADENCE`, and `EXPECTED_BUILD` with the selection job's outputs before executing work.

Selection is conservative. A full quality and performance run is required when the merge base, history, or paths cannot be validated; classification is invalid; dynamic loading or another relationship cannot be resolved; changed runtime source has no matching tests; or a source boundary cannot be mapped reliably. Changes to central CI selection and execution scripts, command plans, the performance harness, or its manifest select the complete test suite and both performance shards, including their supporting selection, output, batch, and process-execution modules. Ordinary mapped tooling changes retain affected selection. Explicit mappings cover the worker, chrome, and plugin entry points and code loaded through URLs by the spawned memory runner. CSS and assets outside TypeScript imports select all tests conservatively. Workflow file readers map to script tests. Filesystem boundaries require explicit mappings. There are currently no remote HTTP boundaries; a future one requires an explicit mapping. Missing or uncertain mappings use the full run.

If selected tests reach the complete runtime coverage scope while omitting Unit or Integration tests that consume that runtime, selection falls back to the complete quality and performance gate. This keeps a whole-runtime denominator paired with its supporting tests instead of lowering coverage thresholds or removing reachable modules. A complete runtime scope alone does not force fallback when all product-consuming Unit and Integration tests are already selected; omitted tooling-only tests do not require it.

Test and test-support changes run the directly changed tests plus affected dependents. Production and build-input changes add production build and package verification. Test, tooling, workflow, and documentation changes alone do not trigger a production build when classification is complete. A full test fallback can still omit build and package checks when the change is reliably known to be non-production. Missing history, unknown or production inputs, manual dispatches, and releases require the complete build and package checks. Existing npm download caching remains enabled; CI does not cache `node_modules`.

For non-documentation runs, selection installs dependencies and runs the existing dependency audit before the quality and performance jobs can start. Audit failure fails selection and prevents that fan-out. The hosted quality runner omits its duplicate audit only when `EXPECTED_AUDIT=success` accompanies all four matching expected selection outputs. Any other supplied audit status or incomplete proof fails. Local quality runs without that proof retain the audit, and complete local `npm run ci` remains unchanged. Documentation-only selection skips installation and audit; the final gate requires the corresponding `skipped` audit outcome.

The project has no E2E or Playwright suite. Pull request selection adds no browser, container, or external-service test infrastructure. Existing accessibility checks remain within the selected Unit and Integration coverage.

## Coverage semantics

Selected tests run with V8 coverage. The existing thresholds remain 85% for lines, statements, and functions and 80% for branches. Coverage includes the selected tests' forward runtime dependency closure and runtime modules transitively affected by changed source, including affected modules without a selected direct test. This result is explicitly **partial coverage** and does not represent whole-project coverage. Tooling-only tests with no reachable product source do not claim product coverage.

When selection falls back to the full run, coverage includes the complete `src/` tree and enforces the project-wide thresholds. The full local `npm run ci`, manual workflow dispatch, and release workflow continue to run the complete quality and performance gates.

## Performance shards

The [exhaustive performance manifest](../scripts/performance-test-manifest.mjs) remains the source of truth. The shared shard selects affected invariant work/resource files and runs them at 120 Hz. The cadence shard selects affected scheduling files and runs every selected file at 60, 90, 120, 144, and 240 Hz. A full fallback runs the complete manifest in both shards. A validated affected plan may have no files for an individual shard, which returns a successful no-work result for that shard; documentation-only changes have no work in either shard. Empty or skipped work is valid only when it matches the recomputed selection. An empty or invalid overall plan and unexpected skips fail closed.

Missing, malformed, stale, tampered, failed, cancelled, or unexpectedly skipped selection or execution results fail closed. The final required `CI` check succeeds only when selection and quality complete successfully and both performance contexts either complete their selected contracts or report no-work that matches the recomputed plan.

## Runner outputs and workflow fixtures

The planner publishes optional `GITHUB_OUTPUT` and `GITHUB_STEP_SUMMARY` data only to existing, owned, regular single-link files directly under the canonical `RUNNER_TEMP/_runner_file_commands` directory, using the runner's `set_output_` and `step_summary_` prefixes. It rejects external paths, redirected command directories, symlinks, hardlinks and file-identity changes before appending through the opened handle. `RUNNER_TEMP` is trusted runner configuration; this does not isolate a compromised runner. With both output variables absent, local planning needs no runner directory and continues to print its outputs to stdout.

Workflow regressions execute repository-owned shell from exclusive temporary script files with bounded child processes and owned cleanup. They do not pass workflow contents as shell command strings. Condition tests interpret only the required string/boolean comparisons, logical operators and own context-property access through a bounded TypeScript AST fixture. Unsupported syntax fails instead of executing JavaScript. These fixtures verify the actual workflow policies; they are not a sandbox for hostile repository code or a complete GitHub expression implementation.

## Local reproduction

To reproduce a pull request plan locally, check out the simulated merge result containing the pull request base and head commits, export their SHAs, and set the event to `pull_request`. `CI_MERGE=<merge-sha>` is optional locally and requires that exact checkout when supplied. First print the plan and its `shared` and `cadence` outputs:

```sh
CI_BASE=<base-sha> CI_HEAD=<head-sha> CI_EVENT=pull_request node scripts/ci-plan.mjs
```

For an affected or full plan, run the quality runner. Run a performance runner only when the corresponding printed output is `true`; an intentional empty shard has no runner invocation. A documentation-only plan has no application runners. Each runner computes and validates its plan once from the checkout; it neither reads nor writes `.ci-selection.json` and needs no separate consumer planning command. Leave `EXPECTED_AUDIT` unset for local reproduction so the quality runner performs its own audit. Existing npm commands keep their full local behavior; `npm run ci`, `npm run ci:quality`, and `npm run benchmark` are not changed by pull request selection.

```sh
CI_BASE=<base-sha> CI_HEAD=<head-sha> CI_EVENT=pull_request node scripts/run-ci.mjs quality
CI_BASE=<base-sha> CI_HEAD=<head-sha> CI_EVENT=pull_request node scripts/run-ci.mjs shared  # only when shared=true
CI_BASE=<base-sha> CI_HEAD=<head-sha> CI_EVENT=pull_request node scripts/run-ci.mjs cadence # only when cadence=true
```
