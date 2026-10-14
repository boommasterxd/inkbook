# GitHub setup review and selected corrections

## Implementation follow-up

Selected corrections were authorized on 2026-10-15 and prepared on
`codex/github-setup-review`. The provider settings below were applied and read back.
The user explicitly authorized publication through a pull request and squash merge
to `main` using the admin bypass despite the known dependency-audit failure. Actual
publication state and check results are recorded in the pull request metadata.
The original review snapshot is retained below as the before-state; its source
findings describe the inspected commit rather than the implemented corrections.

| Selected control                | Before                                                             | Current state                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secret scanning                 | Tree only                                                          | Local workflow keeps tree scanning and adds full-history checkout, PR base-to-head scanning and manual all-history scanning; invalid commits/events or shallow history fail closed  |
| Dependabot auto-merge           | Actor-only guard, all minor/patch ecosystems, workflow-wide writes | Local metadata-only target-event workflow checks actor, author, matching repositories and nonfork source; only npm minor/patch updates qualify; only merging has writes             |
| Provider action SHA enforcement | `sha_pinning_required: false`                                      | Live `true`, read back after the API update; Actions remain enabled and the existing selected-action allowlist is unchanged                                                         |
| Final CI gate                   | Quality job named `CI`, independent performance jobs               | Local quality job renamed `Quality gates`; unconditional final `CI` requires quality and the complete performance matrix to succeed                                                 |
| Required checks                 | Five project-specific names                                        | Live ruleset still requires exactly `CI`, `Performance (shared)`, `Performance (refresh profiles)`, `gitleaks`, `Validate PR Title`; the modified workflow preserves these contexts |

No ruleset rename or removal is necessary: only the producer of the existing `CI`
context changes. `Quality gates` is an internal prerequisite, not an additional
required context. Strict up-to-date checks and the admin-only bypass are retained.
No workflow run or PR was created solely for verification. Publication uses the
normal PR process with the expressly authorized admin override. Bypassing a failed
or pending check is not evidence that it passed; the audit failure stays visible.

Verification of the first implementation stage used Node 24.22.0 / npm 11.19.1 after
`npm ci`. All 58 new workflow regression cases pass, and actionlint 1.7.12 accepts
the three modified workflows. Independent source review found no actionable
defect. The actual gitleaks 8.30.1 executable also passed isolated Git fixtures:
clean tree and excluded base history return success; introduced-and-removed PR
secrets, manual all-history secrets and current tree secrets return failure.
Synthetic tokens were not logged, and temporary fixtures were removed.

The complete local `npm run ci` passed formatting, lint, styles/layout,
architecture, all typechecks, 6,196 tests with coverage, zero-duplication and
dead-code checks, then failed at the existing seven high-severity audit reports.
The following native build and package-verification stages were run separately
and passed. The separate `npm run benchmark` continuation also passed all 114
refresh-rate-invariant files and all 20 cadence-sensitive files at each of 60, 90,
120, 144 and 240 Hz. No dependency fix or audit exception was introduced. The
overall CI result remains a failure because of the existing audit findings.

The following additional corrections were subsequently authorized:

- PR creation was changed live from `all` to `collaborators_only` and confirmed by
  a separate repository API readback.
- The updated CI and gitleaks workflows restrict PR triggers to `main`, retaining
  their manual dispatches and existing required-check contexts.
- The updated scanner updater skips an existing version branch or open update PR
  before downloading checksums or changing the manifest. GitHub/Git lookup failures
  fail closed; only `git ls-remote` exit code 2 means no matching branch. Scheduled
  and manual runs share a concurrency group without cancelling active work, and
  the update job has a ten-minute timeout. Provider targets are explicit.

Incremental verification covers 73 workflow regression cases, including 13 updater
cases and both main-only PR triggers, plus actionlint for the modified workflows.
Focused ESLint, source-layout, zero-duplication and dead-code checks passed. The
updater tests execute its shell and manifest changes with isolated provider-command
mocks; no live update PR was opened. An independent source review found no material
defect. The earlier product, coverage, build and performance evidence remains
applicable because this amendment changes automation and documentation only; those
expensive suites were not repeated. The known audit failure remains unresolved.

The user explicitly retained the unattributed-Copilot approval flag unchanged:
`require_extra_approval_for_unattributed_changes: false`, confirmed through the
ruleset API before and after the repository-policy update. This is an
`accepted-exception` to the template value. The flag is specific to Copilot PRs not
attributed to a person and has no effect with the current zero required approvals.
See [GitHub's rule documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#additional-approval-for-unattributed-copilot-pull-requests).

## Original review snapshot

## Assessment and scope

The repository is partially aligned with the personal GitHub baseline. Main-branch
protection, current-branch enforcement, the five project-required checks, Node.js
selection, action pins and most dependency-update settings are correct. Material
gaps remain in secret-history scanning, dependency auto-merge restrictions and
provider enforcement. Recent merges also bypassed a failing dependency-audit gate.

- Review completed: 2026-10-15; coding-tools 0.29.0 GitHub baseline dated 2026-10-14.
- Target: private `boommasterxd/inkbook`, repository ID `1338357645`, default branch `main`.
- Inspected source and live `main`: `3887f20a7713cce3c21e979649958e052647299b`.
- Scope: GitHub repository settings, rulesets, Actions, six source workflows,
  dependency/scanner configuration, CI interfaces and available execution evidence.
- Excluded: Vercel, Next.js, local application foundation and product/UI acceptance.
- Authority: review only. No provider settings, workflows, dependencies or tests changed.
  Only this report and its required documentation-index entry were written on
  `codex/github-setup-review`; nothing was committed, pushed or published.

Project-specific instructions take precedence over the generic baseline. Accepted
departures below remain visible rather than becoming corrective requirements.

## Material findings

### GH-01: Recent merges bypassed failed CI

The intentional admin bypass is configured correctly. Its actual use nevertheless
means the latest merge does not have passing CI evidence:

| PR                                                    | Tested head                                | CI run                                                                          | Result at merge                                                       |
| ----------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [86](https://github.com/boommasterxd/inkbook/pull/86) | `285b93b62755095636494bea8d201ae112025453` | [38636929866](https://github.com/boommasterxd/inkbook/actions/runs/38636929866) | Quality failed; both performance checks passed; admin bypass recorded |
| [90](https://github.com/boommasterxd/inkbook/pull/90) | `d9fc64596ccc01ab985375a5e8890196a13ef098` | [38638847672](https://github.com/boommasterxd/inkbook/actions/runs/38638847672) | Quality failed; both performance checks passed; admin bypass recorded |

Ruleset evaluation suites `4529013184` and `4529231082` report `result: bypass`
by the repository owner and explicitly identify the failing required `CI` check.
Both quality logs end at `npm audit` with seven high-severity dependency reports.
A read-only audit of the current lockfile confirms seven high reports in the
Stylelint/micromatch dependency tree. These are dependency-audit reports, not seven
independently validated exploitable application vulnerabilities.

Correction: resolve the dependency findings through compatible dependency changes
and obtain passing PR checks before normal merging. Preserve the audit threshold
and the intentional admin-only bypass; a bypass must not be described as passing CI.
Dependency remediation is outside this review. The audit's suggested forced major
changes require compatibility analysis and are not a ready-made fix.

### GH-02: Secret scanning omits introduced commit history

[`gitleaks.yml`](../../.github/workflows/gitleaks.yml) uses default shallow checkout
and runs only `gitleaks dir`. A secret committed and then removed within a PR can
remain in introduced history without being present in the scanned merge tree.
Manual dispatch also does not scan history.

Correction: retain tree scanning, fetch complete history and add a redacted
`gitleaks git` scan over PR base-to-head commits, or complete history for manual
runs. The existing binary checksum verification and built-in rules should remain.

### GH-03: Dependabot auto-merge has broader eligibility and weaker guards

[`dependabot-auto-merge.yml`](../../.github/workflows/dependabot-auto-merge.yml)
uses `pull_request`, workflow-wide write permissions, an actor-only guard and
minor/patch classification without checking the ecosystem. GitHub Actions updates
can therefore qualify although the baseline permits automatic merging only for
npm minor/patch updates. PR author, matching base/head repository and nonfork guards
are absent. The workflow does not check out or execute PR code.

Correction: use the baseline's metadata-only `pull_request_target` inspection,
validate actor and author plus same-repository/nonfork conditions, require
`npm_and_yarn` and minor/patch, and restrict write permissions to the merge job.
Keep npm majors and Actions updates manual. Verify effective token behavior on a
subsequent authorized PR; successful old job labels alone do not prove every update
can enable auto-merge. See [GitHub's Dependabot guidance](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/troubleshooting-dependabot-on-github-actions).

### GH-04: Action SHA pinning is not enforced by GitHub

`GET /repos/boommasterxd/inkbook/actions/permissions` returns
`sha_pinning_required: false`. All current external action references are full
SHAs, and all four distinct pins match their upstream version tags. Source
conformance does not prevent a future workflow from introducing an unpinned action.

Correction: enable repository enforcement of full-length SHA pins and read it back.
The existing restricted action allowlist can be retained. This control is supported
in [GitHub's Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository).

### GH-05: Required CI is the quality job, not a final aggregate gate

[`ci.yml`](../../.github/workflows/ci.yml) correctly names both workflow and quality
job `CI`, but has no unconditional final job requiring quality and both performance
results to succeed. The active ruleset independently requires both performance
checks, so this is a structural baseline departure, not evidence that a failed
performance check currently permits normal merging.

Correction: give quality an internal job name and emit the unique `CI` check from
an `always()` final gate that explicitly rejects failure, cancellation and
unexpected skips of every prerequisite. Preserve the two required performance
check names and the project's full-gate policy.

### GH-06: Small provider-policy differences remain

| Setting                                     | Baseline             | Effective value               | Correction / impact                                                                                            |
| ------------------------------------------- | -------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Extra approval for unattributed Copilot PRs | `true`               | `false` in ruleset `20986962` | Baseline value difference; GitHub documents no effect with zero required approvals                             |
| PR creation policy                          | `collaborators_only` | `all`                         | Align the repository PR-creation policy; this is not evidence that the private repository is publicly readable |
| Projects                                    | Disabled             | Enabled                       | Disable if following the standard feature set                                                                  |
| Squash title                                | `COMMIT_OR_PR_TITLE` | `PR_TITLE`                    | Baseline difference; current setting consistently uses the validated PR title                                  |
| Squash body                                 | `COMMIT_MESSAGES`    | `PR_BODY`                     | Baseline difference; choose the baseline if individual commit messages should be retained                      |

These values were read from the repository API and full active ruleset. The squash
settings are workflow preferences rather than a demonstrated protection weakness.
No explicit project exception for these differences was found.

### GH-07: PR CI and scanner triggers are not limited to main

Both `ci.yml` and `gitleaks.yml` use unrestricted `pull_request` triggers. The
baseline limits these checks to PRs targeting `main`. PRs against other branches
would run the same work unnecessarily under the selected release policy.

Correction: add `branches: [main]` to both PR triggers, retaining authorized manual
dispatch. Extra execution on other target branches was not demonstrated in the
sampled runs; this finding concerns configured scope, not measured costs.

### GH-08: Scanner updater lacks duplicate-update protection and timeouts

[`update-gitleaks.yml`](../../.github/workflows/update-gitleaks.yml) unconditionally
creates and pushes a deterministic version branch and opens a PR. If the update
remains unmerged at the next scheduled/manual run, the existing remote branch can
make the push fail. The baseline checks for an existing version branch first.

Correction: detect an existing version branch/PR and finish without duplicate work.
Add explicit job timeouts to the updater and Dependabot automation, as provided by
the baseline. They currently rely on GitHub's default timeout. Optional operational
improvement: the release job also lacks an explicit timeout; select a bound compatible
with its combined quality and performance work while preserving the PR jobs' limits.

## Coverage and scoped departures

`verified` means the inspected source/provider layer satisfies the stated control;
it does not imply unexecuted runtime checks passed.

| Control                                                                                            | Status             | Evidence / reason                                                                                                                                |
| -------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Private repository, default `main`, matching remote                                                | verified           | Repository API and local remote; live main SHA matches inspected source                                                                          |
| Squash only, auto-merge, delete merged branches, no update suggestions                             | verified           | Effective repository values match baseline                                                                                                       |
| Issues / Wiki / Discussions / Pages                                                                | verified           | Enabled / disabled / disabled / disabled                                                                                                         |
| Projects, PR creation and squash metadata                                                          | drift              | GH-06                                                                                                                                            |
| Active default-branch ruleset, no exclusions                                                       | verified           | `20986962`, active, `~DEFAULT_BRANCH`                                                                                                            |
| Block deletion and non-fast-forward updates                                                        | verified           | Full ruleset and effective `rules/branches/main`                                                                                                 |
| PR required; squash only; zero approvals; no CODEOWNERS/last-push/stale-review/thread requirements | verified           | Full ruleset readback                                                                                                                            |
| Extra approval for unattributed changes                                                            | drift              | GH-06                                                                                                                                            |
| Required `CI`, `gitleaks`, `Validate PR Title`, no App binding                                     | verified           | Source check names, live rules and current check runs agree                                                                                      |
| Two additional required performance checks                                                         | accepted-exception | Explicit project instructions require both names; both active in rules                                                                           |
| Strict up-to-date branch checks; checks enforced on branch creation                                | verified           | `strict_required_status_checks_policy: true`; `do_not_enforce_on_create: false`                                                                  |
| Admin `always` bypass, no additional user/bot bypasses                                             | verified           | Only repository admin role `5`; actual bypass use described in GH-01                                                                             |
| Legacy protection / additional tag rules                                                           | verified           | Legacy API returns 404; effective protection comes from ruleset; version-tag ruleset `20986966` active                                           |
| Actions enabled / action allowlist                                                                 | verified           | Selected actions: GitHub-owned plus fetch-metadata and semantic-pull-request; stricter than baseline's all-actions allowance; retain             |
| Provider SHA enforcement                                                                           | drift              | GH-04                                                                                                                                            |
| Default token read / Actions PR creation allowed                                                   | verified           | Workflow permissions API                                                                                                                         |
| Private fork workflows allowed with approval; no secrets/write tokens                              | verified           | Dedicated private-fork policy API                                                                                                                |
| No self-hosted runners, deploy keys or repository webhooks                                         | verified           | Counts zero / empty lists                                                                                                                        |
| No Actions/Dependabot secrets, Actions variables or environments                                   | verified           | Counts zero / empty environments; no values retrieved                                                                                            |
| Dependabot alerts and automatic security updates                                                   | verified           | Alerts endpoint HTTP 204; fixes enabled and not paused                                                                                           |
| Native Code Scanning and Secret Scanning disabled                                                  | verified           | Dedicated API errors explicitly identify disabled features; matches baseline                                                                     |
| Assigned Code Security configuration                                                               | verified           | Endpoint HTTP 204, no assigned configuration                                                                                                     |
| Log/artifact retention                                                                             | verified           | Seven days; the baseline's 90 days is a reference default, not a mandatory control; shorter retention reduces available investigation evidence   |
| OIDC subject                                                                                       | not-applicable     | No job requests `id-token`; provider uses default immutable subject, unlike baseline snapshot; no consumer requires correction                   |
| Account plan, installed Apps, push protection, Copilot review                                      | unverified         | Plan omitted; integrations and these account/dashboard controls not established                                                                  |
| All five baseline workflow roles                                                                   | verified           | CI, title, Dependabot merge, gitleaks and scanner updater present and active                                                                     |
| Full-SHA action references and upstream identity                                                   | verified           | Four distinct pins match upstream tags: checkout 7.0.1, setup-node 7.1.0, semantic PR 6.1.1, metadata 3.1.0                                      |
| Project Node.js runtime in every applicable Actions job                                            | verified           | Quality, both performance jobs and release use latest `24.x` selection with `check-latest: true`                                                 |
| Existing resolved Node.js execution                                                                | verified           | PR 90 quality log: Node 24.21.0, npm 11.19.0; no claim about a new local install                                                                 |
| Normal synthetic merge checkout                                                                    | verified           | No PR-head override; PR 90 log checks out `c134a7c`, head merged into recorded base `5e959724...`                                                |
| Workflow and required check named CI                                                               | verified           | YAML, ruleset and emitted context all match                                                                                                      |
| Final unconditional CI aggregation                                                                 | drift              | GH-05; separate required performance contexts still protect normal merges                                                                        |
| Pure root docs-only short path                                                                     | accepted-exception | Project requires complete PR gate in AGENTS.md and quality-and-testing.md; no classifier; changing this requires a policy decision               |
| CI/scanner automatic execution only for main-target PRs                                            | drift              | GH-07; manual dispatch itself is explicitly permitted                                                                                            |
| No automatic post-merge main CI/secret rescan                                                      | verified           | No current source trigger; queried main push history has no CI/scanner push run after August 25; older removed paths are not current findings    |
| Substantive quality/build/package interfaces                                                       | verified           | check-command-plan.mjs includes formatting, lint, types, architecture, coverage, duplication, dead-code, audit, build and package verification   |
| Coverage, complexity and zero duplication configuration                                            | verified           | 85/85/85/80 coverage, project hard maxima, jscpd `minTokens: 50`, threshold 0                                                                    |
| Audit threshold                                                                                    | accepted-exception | Project explicitly requires high-severity blocking rather than baseline info; current lockfile fails even this threshold                         |
| Current successful full quality/build evidence                                                     | unverified         | Latest sampled quality runs fail at audit before build/package stages; no fresh full suite run in this review                                    |
| Deterministic performance suite and runner limits                                                  | verified           | Both latest PR shards passed; exhaustive manifest and five cadence profiles; Ubuntu jobs limited to 20 minutes                                   |
| Website production-server/E2E extensions                                                           | not-applicable     | Obsidian plugin; project explicitly uses Unit and focused Integration tests                                                                      |
| Conventional PR-title policy                                                                       | verified           | Expected types, optional scope, Dependabot actor exception                                                                                       |
| Dependabot schedule/groups/labels/limits                                                           | verified           | Weekly Monday 08:00 Europe/Berlin; ten PRs per ecosystem; required labels present                                                                |
| CodeMirror peer update exclusions                                                                  | accepted-exception | Explicit Obsidian compatibility policy; selected state/view peers ignored                                                                        |
| Dependency auto-merge eligibility/guards/permissions                                               | drift              | GH-03; existing historical enablement does not validate broader policy                                                                           |
| Scanner manifest, checksum and built-in rules                                                      | verified           | 8.30.1 Linux x64 checksum matches upstream; archive verified before execution; default rules extended; no ignore file found                      |
| Tree and introduced-history scan                                                                   | drift              | Tree scan passes in latest PR; history scan absent, GH-02                                                                                        |
| Monthly scanner update and exact checksum parsing                                                  | verified           | First day 06:00 UTC plus manual dispatch; exact archive name and tag/hash validation; normal PR, no automatic merge                              |
| Updater idempotency / explicit automation timeouts                                                 | drift              | GH-08                                                                                                                                            |
| Native Obsidian release role                                                                       | accepted-exception | Tag-only native release intentionally reruns complete gate; validates numeric tag, manifest and main ancestry; not duplicate main-push CI        |
| Current release publication/runtime evidence                                                       | unverified         | Source inspected; no release dispatched or publication performed                                                                                 |
| Obsolete proof workflow metadata                                                                   | not-applicable     | Provider still lists two proof workflows as active; files absent on inspected main; metadata alone does not establish a runnable current trigger |

## Verification and remaining limits

Read-only verification used `git`, `rg`, `gh api`, existing Actions job logs and
official GitHub documentation. Queries covered repository metadata, complete
ruleset details and effective branch rules, rule evaluation suites, Actions/fork/
retention/OIDC policies, secret/variable counts, security status, workflows, recent
PRs, check runs and main push-run history. No secret values were requested.

All distinct action SHAs were compared with upstream Git tag refs. The gitleaks
8.30.1 manifest hash was compared with the published Linux x64 checksums file:
`551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`.
This verifies the published pairing, not independent release authenticity.

`npm audit --package-lock-only --json` reported seven high and no critical findings.
It used the existing lockfile without installing or updating dependencies. The
inspection shell resolved Node 26.11.1 / npm 12.2.0; local runtime setup was outside
scope, and no local application checks are represented as Node 24 verification.

No new full CI, build, performance suite, scanner execution, workflow dispatch,
test PR or release was run. Existing job evidence was inspected instead. Two
performance shards and gitleaks passed for the latest PR; quality failed. Product
behavior, hardware acceptance and current release artifacts remain outside this
GitHub settings assessment. Runner costs and monetary savings were not measured.

A separate read-only source review covered workflow semantics and quality
interfaces; the main reviewer checked provider evidence and integrated its results.
The report's Markdown formatting, local links, code fences and recursive
documentation-index coverage were checked. Full conformance is not established
while the reported drift and execution gaps remain.
