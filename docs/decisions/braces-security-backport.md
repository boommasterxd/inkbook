# Temporary braces security backport

## Decision

Keep the existing Stylelint, globby, fast-glob, and micromatch versions. Replace only the vulnerable `braces@3.0.3` dependency with the MIT-licensed `@dieub/braces-depth-guard@3.0.3-pn.3` through an npm override. The lockfile records the exact registry artifact and integrity digest. This development dependency is not part of the production plugin.

The [upstream advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) has no patched release. The [backport](https://github.com/dieub/braces-depth-guard/tree/305a2e4bfe324bb53c336c1b03387ee1251c926f) derives from upstream 3.0.3 and adds parsing and AST-traversal depth guards, with a hard maximum of 100. It preserves the public API and ordinary glob results; excessively nested patterns are rejected. Its provenance identifies commit `305a2e4bfe324bb53c336c1b03387ee1251c926f` and tag `3.0.3-pn.3`.

A renamed package disappearing from an audit is not evidence of remediation. Acceptance requires reviewing the published runtime changes and testing the actual dependency resolved by micromatch. Its existing version is declared as a direct development dependency for this test boundary. Regression tests cover normal compilation/expansion, range limits, deep braces/parentheses, direct AST traversal, child cycles, and option-based attempts to bypass the bound. Arbitrary malformed AST objects and expansion cardinality are separate concerns; this backport does not claim universal resource-exhaustion protection.

## Returning to upstream

Even a version-scoped npm override matches the consumer's dependency range, so `npm update` cannot automatically replace this alias with a future official release. `npm run audit` therefore first checks all published official `braces` versions through the configured npm registry, independently of dist-tags. A newer stable release, changed or relocated backport specification, malformed registry response, or registry failure fails the check. The existing `npm audit --audit-level=high` remains unchanged.

The fork name does not automatically inherit future advisories against upstream code. The guard verifies the lockfile's reviewed backport version and integrity digest, then separately queries the registry's bulk-advisory endpoint for original `braces@3.0.3`. Only the known depth-exhaustion advisory addressed by this reviewed artifact is recognized as fixed. Any additional advisory or change to its URL, title, severity, or vulnerable version range requires review, even before a new upstream version exists. CWE and CVSS recalculations alone do not invalidate the fix. Missing/malformed responses and network errors fail closed. No npm-audit advisory is globally suppressed.

When an official release becomes available, review its fix against the same regression tests. Once fixed, remove the `braces@3.0.3` override, run `npm install` to regenerate the lockfile, and run the complete local gate. Do not change the retirement guard's expected upstream version merely to keep the backport indefinitely. Dependabot remains enabled without a braces ignore rule. After removal, the retirement guard stops querying the registry and ordinary dependency updates resume.

## Verification

Use `npm ci` to confirm reproducible installation, `npm audit signatures` to verify registry signatures and available provenance, and `npm run ci` for the unchanged quality and performance requirements. The regression tests in `test/unit/scripts/braces-security.test.mjs` exercise the installed micromatch dependency rather than a separately imported copy of the backport.
