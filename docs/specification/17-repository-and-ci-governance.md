# Repository and CI Governance

This document owns GitHub repository settings, dependency automation, workflow security, required checks, branch and tag rulesets, secret scanning, and release-asset retention. [Quality and Performance](09-quality-and-performance.md) owns the gates executed by CI. [Obsidian Host Contract](14-obsidian-host-contract.md) owns the plugin package and Community release contract.

## 1. Repository Baseline

The development repository MUST use this baseline:

| Setting                                      | Required value                                             |
| -------------------------------------------- | ---------------------------------------------------------- |
| Visibility during development                | Private                                                    |
| Default branch                               | `main`                                                     |
| Pull-request merge method                    | Squash only                                                |
| Merge commits and rebase merge               | Disabled                                                   |
| Automatic head-branch deletion               | Enabled                                                    |
| Auto-merge                                   | Enabled                                                    |
| Issues and Projects                          | Enabled                                                    |
| Wiki and Discussions                         | Disabled                                                   |
| Default workflow token permission            | Read                                                       |
| Actions may create and approve pull requests | Enabled                                                    |
| Reusable-workflow access                     | None unless a reviewed cross-repository requirement exists |

Every workflow declares an explicit least-privilege `permissions` block. Fork-origin workflows receive neither write tokens nor repository secrets automatically and require the host approval policy. Private development visibility does not override the public repository and metadata requirements for Community submission. Conversion to public visibility is an explicit user-authorized release action, never an automatic workflow side effect.

The repository MUST define these labels exactly:

- `dependencies`, color `#0366d6`, for dependency updates;
- `github-actions`, color `#2088ff`, additionally applied to GitHub Actions updates.

Repository provisioning MUST be idempotent. Its verification command reads the effective settings, labels, workflow permissions, rulesets, security features, and required-check names back from GitHub and fails on drift.

## 2. Rolling Dependency Maintenance

`.github/dependabot.yml` MUST monitor both `npm` at `/` and `github-actions`. Each ecosystem runs weekly on Monday at `08:00` in `Europe/Berlin`, uses an open-pull-request limit of 10, and applies the labels above. Minor and patch updates form one `minor-patch` group per ecosystem. Major updates remain separate pull requests for isolated review and rollback.

Minor and patch Dependabot pull requests MUST request squash auto-merge and merge only after every required check succeeds. Major updates require manual review and MUST NOT auto-merge. The release freshness gate remains authoritative: an unresolved newest stable major update blocks the next phase exit or release rather than turning the old version into a permanent pin.

Dependabot commit and pull-request metadata MUST produce a valid Conventional Commit squash title, using `chore(deps):` for npm and `chore(actions):` for workflow actions. This Inkbook-specific rule intentionally tightens the general repository template because every commit on `main` must follow the project convention. The title validator therefore applies to bot and human pull requests alike.

Dependabot alerts and security-update pull requests MUST be enabled. Security updates are never delayed by the weekly version-update grouping. A known critical or high finding blocks merge, phase exit, and release under [Quality and Performance](09-quality-and-performance.md).

## 3. Required Workflows

All workflow action references MUST use the newest reviewed stable release selected by the rolling-current policy and a full immutable commit SHA with a human-readable version comment. Dependabot maintains the `github-actions` ecosystem so these references remain current. Tag-only action references are forbidden in authored `uses:` lines.

### 3.1 Continuous Integration

`.github/workflows/ci.yml` MUST trigger on every pull request, every push to `main`, and manual dispatch. Concurrency is scoped by workflow and ref with stale in-progress runs cancelled. The workflow uses `npm ci` and executes every applicable Per-Commit gate from [Quality and Performance](09-quality-and-performance.md), including formatting, linting, strict type checking, tests, 85 percent coverage, duplication, dead code, dependency audit, architecture checks, documentation and traceability, provenance, production build, mobile-bundle inspection, and package validation.

The final required job name is exactly `CI`. It depends on every mandatory CI job, uses `if: always()`, and succeeds only when each required predecessor succeeded or was an explicitly valid non-applicable job. A failed, cancelled, timed-out, or unexpectedly skipped mandatory predecessor fails `CI`.

The workflow MUST NOT use trigger-level `paths-ignore`. If measured CI duration later justifies docs-only optimization, one cheap change-classification job may skip only expensive non-applicable work. An unresolved diff base defaults to running all work, and the final `CI` job still reports a truthful required result.

### 3.2 Pull-Request Title

`.github/workflows/commit-style-check.yml` validates every pull-request title against `type(scope): description`, with optional scope and the allowed project types `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, and `revert`. Its required job name is exactly `Validate PR Title`. Because squash merge turns that title into the `main` commit, the workflow does not attempt to enforce every intermediate branch commit.

### 3.3 Dependency Auto-Merge

`.github/workflows/dependabot-auto-merge.yml` runs only for Dependabot pull-request events, reads update metadata through a full-SHA-pinned action, and requests squash auto-merge only for semantic minor or patch updates. It uses exactly `contents: write` and `pull-requests: write`; no broader permission or repository secret is permitted. The merge still waits for `CI`, `gitleaks`, and `Validate PR Title`.

### 3.4 Secret Scan

`.github/workflows/gitleaks.yml` MUST trigger on every pull request, every push to `main`, and manual dispatch. Its required job name is exactly `gitleaks`, its permissions are exactly `contents: read`, and it scans the current checked-out tree in `dir` mode with redaction and a nonzero finding exit code.

The workflow downloads the current stable gitleaks archive named by `.gitleaks-version`, verifies its recorded SHA-256 before extraction or execution, and never pipes a network response directly into a shell or archive tool. `.github/workflows/update-gitleaks.yml` checks the official stable release monthly, verifies the publisher checksum, updates only `.gitleaks-version`, and opens a `dependencies` pull request with explicit `contents: write` and `pull-requests: write` permissions.

`.gitleaks.toml` MAY allow only exact, reviewed non-secret fixture paths or values. A whole `test/` subtree, generic credential pattern, source directory, or production configuration MUST NOT be allowlisted. Every exception records why the value is non-secret and has a regression fixture proving nearby real secrets remain detectable.

## 4. Branch and Tag Rulesets

The active branch ruleset MUST be named `Protect main`, target the default branch, and contain:

- deletion protection;
- non-fast-forward protection;
- pull requests required before merge;
- zero required approvals for the solo-owner workflow;
- squash as the only allowed merge method;
- required checks named exactly `CI`, `gitleaks`, and `Validate PR Title`;
- loose status-check mode, so the branch need not be updated solely to enter auto-merge;
- one built-in administrator-role bypass in `always` mode as an emergency escape hatch.

The ruleset MUST NOT add the `update` rule or permit direct non-bypass pushes. The administrator bypass does not convert a failed check, unreviewed release, or nonconforming artifact into passing evidence. Any emergency use is recorded and followed by the complete missed gates on the resulting `main` commit.

A separate active `v*` tag ruleset prevents deletion, non-fast-forward changes, and updates. Release tags are immutable after creation. A correction receives a new version and tag.

Required status-check strings MUST match the actual job names byte-for-byte. Provisioning verifies that each required check has run successfully in the repository before activating the corresponding requirement, avoiding permanently pending unknown contexts.

## 5. Actions Security

Every workflow uses explicit minimum permissions, untrusted pull-request text is passed through data channels rather than interpolated into executable scripts, and write-capable jobs do not execute untrusted fork code. Workflow-created branches and pull requests use the repository-scoped `GITHUB_TOKEN` unless a documented capability requires a narrower GitHub App token.

The repository-wide full-SHA enforcement toggle MUST remain disabled because it also evaluates transitive actions inside third-party composite actions that Inkbook cannot rewrite. This exception does not relax authored workflows: every direct `uses:` reference remains full-SHA-pinned and reviewed. Action access remains restricted to GitHub-authored and individually reviewed actions required by the workflows.

Secret scanning, push protection, and code scanning MUST be enabled when the active private-repository plan exposes them. Their absence is recorded as a platform capability limitation and never removes the required gitleaks, dependency-audit, static-analysis, and abuse-test gates. `SECURITY.md` instructs reporters to use a private channel and not a public issue; the actual contact is supplied by the user before public release and MUST NOT be invented.

## 6. Release Workflow and Artifacts

`.github/workflows/release.yml` runs for protected `v*` tags and an explicitly authorized manual dispatch. It rebuilds with `npm ci`, executes the cumulative Release lane, requires exact manifest, tag, and requested-version equality, and creates a draft release before any publication. Publication remains a manual user-authorized action.

The release MUST attach the three loadable plugin files `main.js`, `manifest.json`, and `styles.css`. A generated `SHA256SUMS` MAY be attached as supplemental verification metadata but is not part of the loadable plugin package. Release assets are the durable distribution records. Temporary Actions artifacts used between jobs have `retention-days: 3` and are deleted through the artifact API after successful release attachment; failure to delete is reported without deleting the release assets.

The release job grants only the permissions required for release assets, attestations when available, and deletion of its own temporary artifacts. Artifact attestations and an SBOM are produced when the repository plan and permissions support them. No workflow publishes from an unreviewed branch, mutable dependency graph, failed required check, or unverified download.

## 7. Acceptance

Phase 0 and every release MUST verify:

1. repository settings, labels, Actions permissions, security features, and both rulesets match this document;
2. Dependabot opens grouped minor or patch and separate major updates for npm and GitHub Actions with valid Conventional Commit titles;
3. minor or patch auto-merge waits for all three required checks, while major updates remain open;
4. required-check names match exactly and docs-only changes never remain permanently pending;
5. each direct action reference is a reviewed full commit SHA and the freshness check finds no silently retained older stable release;
6. gitleaks rejects a seeded real secret, accepts only exact reviewed fake fixtures, and rejects a checksum mismatch before execution;
7. branch and tag protection reject deletion, force-push, direct non-bypass mutation, and tag replacement;
8. a release candidate produces one immutable draft with the three exact plugin files, matching versions, checksums, bounded temporary retention, and no automatic publication.

The generalized user repository template is design input, not an executable version source. Example action, runtime, Node.js, npm, or gitleaks versions from that template MUST be resolved again through the rolling-current policy when Phase 0 creates the repository.
