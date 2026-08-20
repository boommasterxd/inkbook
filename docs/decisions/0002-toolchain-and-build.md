# ADR 0002: Rolling-Current Toolchain and Build

Status: Accepted

## Context

Inkbook requires current maintained tooling without turning mutable network state into an unreproducible build. Obsidian Android support also requires a production bundle without Node.js, Electron, native modules, remote code, or a fourth runtime artifact.

## Decision

Inkbook uses npm as its only package manager, Node.js 26 during its Current phase and subsequent LTS phases for development and CI, TypeScript, esbuild, ESLint, Prettier, Vitest with V8 coverage, dependency-cruiser, jscpd, knip, and npm audit.

`package.json` uses maintained semantic ranges except where an exact host peer contract is required. The npm-generated lockfile records the exact reviewed graph and `npm ci` reproduces it. Direct GitHub Actions use full immutable commit SHAs because workflow execution is supply-chain-sensitive, while Dependabot continually proposes newer reviewed stable action releases. The runtime plugin never downloads code or dependencies.

The bootstrap resolution on 2026-08-18 selected:

| Component                                       | Resolution                                      |
| ----------------------------------------------- | ----------------------------------------------- |
| Node.js                                         | 26.7.0 Current, scheduled for LTS on 2026-10-28 |
| npm                                             | 12.0.2                                          |
| Obsidian API package                            | 1.13.1                                          |
| CodeMirror commands                             | 6.10.1                                          |
| CodeMirror state                                | 6.5.0                                           |
| CodeMirror view                                 | 6.38.6                                          |
| Current release host used by the initial matrix | 1.13.7                                          |
| esbuild                                         | 0.28.2                                          |
| ESLint                                          | 10.8.1                                          |
| typescript-eslint                               | 8.67.0                                          |
| TypeScript                                      | 6.0.3                                           |
| Prettier                                        | 3.9.6                                           |
| Vitest and V8 coverage                          | 4.1.11                                          |
| fake-indexeddb                                  | 6.2.5                                           |
| happy-dom                                       | 20.11.2                                         |
| dependency-cruiser                              | 18.2.0                                          |
| jscpd                                           | 5.0.16                                          |
| knip                                            | 6.32.2                                          |
| gitleaks                                        | 8.30.1                                          |

TypeScript 7.0.2 was the newest standalone stable TypeScript release at bootstrap, but typescript-eslint 8.67.0 supports TypeScript only below 6.1.0. TypeScript 6.0.3 is therefore the newest stable mutually compatible release, not a permanent preference. The freshness gate MUST move to TypeScript 7 or later as soon as the current linter release supports it. `@types/node` remains on the newest Node 26 line because Node 26 is the selected build and CI runtime.

Obsidian API 1.13.1 declares exact peers on `@codemirror/state` 6.5.0 and `@codemirror/view` 6.38.6. CodeMirror commands 6.11.0 requires state 6.7 or newer, so commands 6.10.1 is the newest stable release compatible with the host-declared graph. These three packages remain exact until a reviewed Obsidian API package advances the peer boundary.

`skipLibCheck` is enabled only because the published Obsidian 1.13.1 declaration bundle contains host classes that declare `HistoryHandler` without declaring its required `onHistoryBack()` member. Project sources and tests remain fully strict and receive no skip or path exclusion. This narrow upstream boundary MUST be retested and removed when a corrected Obsidian declaration release is selected.

The production build targets ES2022, stages CommonJS `dist/main.js`, `dist/manifest.json`, and `dist/styles.css`, treats Obsidian, CodeMirror, and Lezer host packages as external, copies the namespaced stylesheet, minifies release output, and emits no source map. The release exposes those three files at the root of the installed plugin package.

## Update Policy

Dependabot checks npm and GitHub Actions weekly. Minor and patch updates may auto-merge only through all required checks. Major updates remain isolated for review. Node.js, npm, and gitleaks updates are reviewed when their upstream release channels change. An older version is accepted only while a documented current compatibility constraint makes the newer version unusable; such a constraint blocks silent drift and is removed at the first compatible update. Test-only tools are added when a real executable suite needs them, not as unused placeholders.

## Consequences

Daily builds remain reproducible through the lockfile while maintenance continuously follows current stable releases. Build and CI action versions are compatibility inputs, not permanent project constants. Phase 0 remains incomplete until its automated host-history, worker, IndexedDB, view-attachment, input, zoom, lifecycle, resource-boundary, and build checks pass, followed by the one concise Phase 0 sanity scenario defined by the roadmap.

## References

- [Implementation Roadmap](../specification/11-implementation-roadmap.md)
- [Quality and Performance](../specification/09-quality-and-performance.md)
- [GitHub and CI](../specification/17-github-and-ci.md)
- [Obsidian Host Contract](../specification/14-obsidian-host-contract.md)
