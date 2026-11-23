# Repository administrator bypass

The repository owner intentionally retains the GitHub `RepositoryRole` bypass for the repository administrator role on the `Protect main` ruleset. The owner is the sole holder of that role. This preserves the owner's ability to override the ruleset with a deliberate administrative action.

The ruleset requires pull requests and passing checks, including `gitleaks`. A deliberate administrator bypass can update `main` without those checks passing. The required checks continue to apply to ordinary pull requests.
