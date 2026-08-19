# GitHub and CI

## 1. Repository

The canonical repository is `boommasterxd/inkbook`. It remains private until the owner explicitly approves public release. The default branch is `main`. Pull requests use squash merge, merged branches are deleted automatically, and direct deletion or non-fast-forward updates of protected branches and `v*` tags are blocked.

The `main` ruleset requires these checks:

- `CI`;
- `gitleaks`;
- `Validate PR Title`.

Repository Actions use read-only permissions by default. Workflows receive only the permissions declared for their job. Fork workflows receive no secrets or write token.

## 2. Dependency Updates

Dependabot checks npm and GitHub Actions every Monday at 08:00 Europe/Berlin. Minor and patch updates are grouped and may use squash auto-merge only after every required check passes. Major updates remain separate for manual compatibility review.

Every authored third-party `uses:` reference MUST use a full 40-character commit SHA with the reviewed release tag in a comment. Dependabot updates the SHA and comment together. Gitleaks uses the version and checksum in `.gitleaks-version`; the monthly updater opens a pull request when a newer stable release exists.

## 3. Workflows

- `ci.yml` installs the lockfile with `npm ci`, runs `npm run ci`, and fails deterministic raw, compressed, CSS, and embedded-worker byte checks from `ARTIFACT_BUDGET_V1` on pull requests, `main`, and manual dispatch.
- `commit-style-check.yml` validates pull-request titles as English Conventional Commits.
- `dependabot-auto-merge.yml` requests squash auto-merge only for Dependabot minor and patch updates.
- `gitleaks.yml` scans the complete reachable history with the reviewed gitleaks binary and checksum.
- `update-gitleaks.yml` checks monthly for a newer verified gitleaks release and opens a pull request.
- `release.yml` validates the tag and manifest version, runs `npm run ci`, builds the plugin, creates checksums, validates the release-evidence manifest against the exact artifact digest, and creates a draft GitHub release only when every required automated and manual evidence cell is current.

No workflow publishes a release automatically. Publishing the reviewed draft remains an explicit owner action.

The local build stages generated files under the ignored `dist/` directory. Release uploads preserve the required basenames, so installed plugin directories contain `main.js`, `manifest.json`, and `styles.css` directly at their root.

## 4. Release Assets

One release contains:

- `main.js`;
- `manifest.json`;
- `styles.css`;
- `SHA256SUMS`.

The manifest version, `package.json` version, `versions.json` entry, and `v*` tag MUST remain consistent. Generated build files are not committed.

## 5. Performance Evidence

Each phase and release performance run emits one schema-validated evidence record containing the stable row IDs, commit, production `main.js` SHA-256, complete package checksum set, `PerformanceProfileV1` version, fixture generator and digest, Obsidian and operating-system versions, hardware or Android device identity, refresh rate, sample and warmup counts, measured percentiles and maxima, heap and resource-ledger high-water marks, pass or fail state, and manual reviewer when required. A record is immutable after its run. Missing fields, an artifact or profile mismatch, a threshold selected after measurement, or evidence from another commit fails validation.

CI validates schemas, deterministic artifact bytes, fixture digests, and automated results. Real-device execution may remain an explicit manual Phase-Exit or Release step, but its signed-off record must be present and bound to the same production digest before `release.yml` creates a draft. The workflow never fabricates, updates, or marks a real-device result passing. Evidence files are retained with the applicable test result or release record rather than as empty governance placeholders.

## 6. GitHub Security Settings

Dependabot alerts and automated security updates remain enabled. Secret scanning and push protection MUST be enabled when GitHub makes them available for the repository. The inability to enable a plan-dependent feature is recorded as a platform limitation and MUST NOT be misrepresented as active protection.
