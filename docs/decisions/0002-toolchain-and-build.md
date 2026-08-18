# ADR 0002: Rolling-Current Toolchain and Build

Status: Accepted

## Context

Inkbook requires current maintained tooling without turning mutable network state into an unreproducible build. Obsidian mobile support also requires a production bundle without Node.js, Electron, native modules, remote code, or a fourth runtime artifact.

## Decision

Inkbook uses npm as its only package manager, Node.js active LTS for development and CI, TypeScript, esbuild, ESLint, Prettier, Vitest with V8 coverage, fast-check, Playwright, dependency-cruiser, jscpd, knip, npm audit, and project-owned validation scripts.

`package.json` uses maintained semantic ranges. The npm-generated lockfile records the exact reviewed graph and `npm ci` reproduces it. Direct GitHub Actions use full immutable commit SHAs because workflow execution is supply-chain-sensitive, while Dependabot continually proposes newer reviewed stable action releases. The runtime plugin never downloads code or dependencies.

The bootstrap resolution on 2026-08-18 selected:

| Component                                       | Resolution                  |
| ----------------------------------------------- | --------------------------- |
| Node.js                                         | 24.19.0 active LTS, Krypton |
| npm                                             | 12.0.2                      |
| Obsidian API package                            | 1.13.1                      |
| Current release host used by the initial matrix | 1.13.7                      |
| esbuild                                         | 0.28.2                      |
| ESLint                                          | 10.8.1                      |
| typescript-eslint                               | 8.67.0                      |
| TypeScript                                      | 6.0.3                       |
| Prettier                                        | 3.9.6                       |
| Vitest and V8 coverage                          | 4.1.10                      |
| fast-check                                      | 4.9.0                       |
| Playwright                                      | 1.62.1                      |
| dependency-cruiser                              | 18.2.0                      |
| jscpd                                           | 5.0.16                      |
| knip                                            | 6.32.2                      |
| gitleaks                                        | 8.30.1                      |

TypeScript 7.0.2 was the newest standalone stable TypeScript release at bootstrap, but typescript-eslint 8.67.0 supports TypeScript only below 6.1.0. TypeScript 6.0.3 is therefore the newest stable mutually compatible release, not a permanent preference. The freshness gate MUST move to TypeScript 7 or later as soon as the current linter release supports it. `@types/node` remains on the newest Node 24 line because Node 24 is the selected active-LTS runtime.

`skipLibCheck` is enabled only because the published Obsidian 1.13.1 declaration bundle contains host classes that declare `HistoryHandler` without declaring its required `onHistoryBack()` member. Project sources and tests remain fully strict and receive no skip or path exclusion. This narrow upstream boundary MUST be retested and removed when a corrected Obsidian declaration release is selected.

The production build targets ES2022, produces CommonJS `main.js`, treats Obsidian, CodeMirror, and Lezer host packages as external, copies the namespaced stylesheet, minifies release output, and emits no source map. The release package contains exactly `main.js`, `manifest.json`, and `styles.css`.

## Update Policy

Dependabot checks npm and GitHub Actions weekly. Minor and patch updates may auto-merge only through all required checks. Major updates remain isolated for review. Before every phase exit and release freeze, `npm run freshness:check` resolves official stable channels again. An older version is accepted only while a documented current compatibility constraint makes the newer version unusable; such a constraint blocks silent drift and is removed at the first compatible update.

## Consequences

Daily builds remain reproducible through the lockfile while maintenance continuously follows current stable releases. Build and CI action versions are evidence, not permanent project constants. Phase 0 remains incomplete until host-history, worker, IndexedDB, view-attachment, touch, zoom, mobile, and real-device probes pass the compatibility matrix.

## References

- [Implementation Roadmap](../specification/11-implementation-roadmap.md)
- [Quality and Performance](../specification/09-quality-and-performance.md)
- [Repository and CI Governance](../specification/17-repository-and-ci-governance.md)
- [Obsidian Host Contract](../specification/14-obsidian-host-contract.md)
