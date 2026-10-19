# Inkbook

Inkbook is an Obsidian plugin for creating and editing responsive handwriting embeds stored as self-contained SVG files. Notes use the explicit non-image syntax `!inkbook[[path.svg]]`, so Inkbook owns the complete presentation while ordinary SVG embeds and image plugins remain unaffected. It is designed for low-latency pen, touch, and mouse input while preserving a portable static SVG outside the plugin.

## Project status

The first-release implementation is present and is being validated as a release candidate. It includes:

- pen, highlighter, straight highlighter, eraser, selection, and lasso tools
- lines, arrows, closed shapes, coordinate systems, and configurable tables
- layer ordering within fixed render bands
- shape-anchor snapping with persistent line and arrow connections
- backgrounds, page expansion, zoom, clipboard actions, and command history
- locked SVG previews across tabs, panes, and pop-out windows with one active editor per workspace
- responsive interaction with the required 10,000-stroke acceptance dataset

The automated suite covers pure domain behavior and focused Obsidian, renderer, worker, vault, clipboard, and settings boundaries through deterministic adapters. Real-device validation in Obsidian, including mobile hardware, pop-out windows, pen input, and external SVG editors, remains a manual release step. See [docs/specification.md](docs/specification.md) for the normative scope and [docs/quality-and-testing.md](docs/quality-and-testing.md) for acceptance budgets.

## Requirements

- Latest Node.js 24.x (`nvm install` resolves the major alias in `.nvmrc`)
- npm
- Obsidian 1.13.0 or newer

## Development

```sh
npm ci
npm run dev
```

Development and production output is written to `dist/`. Copy its contents, or link the directory, to `<vault>/.obsidian/plugins/inkbook`, then reload Obsidian and enable Inkbook under Community plugins.

Useful commands:

| Command                    | Purpose                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run dev`              | Watch source and emit a development build with inline source maps.                           |
| `npm run build`            | Create the minified production plugin package under `dist/`.                                 |
| `npm test`                 | Run the Unit and focused Integration test suites.                                            |
| `npm run test:coverage`    | Enforce 85 percent lines, statements, and functions plus 80 percent branches.                |
| `npm run test:unit`        | Run only deterministic Unit tests.                                                           |
| `npm run test:integration` | Run only focused boundary Integration tests.                                                 |
| `npm run test:performance` | Run the complete classified performance profiles.                                            |
| `npm run lint`             | Enforce Obsidian, naming, size, complexity, architecture-boundary, and mobile-runtime rules. |
| `npm run lint:styles`      | Validate source CSS with Stylelint.                                                          |
| `npm run lint:layout`      | Validate source/test naming, Scene file type, and CSS file size.                             |
| `npm run architecture`     | Reject source dependency cycles and invalid area directions.                                 |
| `npm run typecheck`        | Type-check plugin source separately from Node-based test tooling.                            |
| `npm run typecheck:worker` | Type-check the actual worker graph without main-thread platform types.                       |
| `npm run ci`               | Run the complete local quality and performance gate.                                         |
| `npm run benchmark`        | Run classified work, resource, and simulated-scheduling checks.                              |
| `npm run package:verify`   | Verify versions and the exact Obsidian release-artifact envelope.                            |

The complete gate also checks formatting, source layout, import cycles and direction, worker isolation, duplication, dead code, dependency vulnerabilities, coverage, deterministic performance budgets, the production build, and package contents. Pull request CI selects affected tests and performance contracts from the complete base-to-head diff, with a full-gate fallback whenever selection is uncertain. Manual dispatches, release validation, and local `npm run ci` retain the complete gate. See [the affected CI contract](docs/ci-selection.md).

## Architecture

The implementation follows five dependency-directed responsibility areas:

- `domain`: pure elements, geometry, commands, schemas, and spatial data
- `editor`: input arbitration, gestures, selection, sessions, and autosave scheduling
- `rendering`: framework-free motion contracts, asynchronously loaded React application chrome, and the separate imperative SVG scene
- `persistence`: document codecs, migrations, worker tasks, and save orchestration
- `obsidian`: plugin lifecycle, embeds, settings, host adapters, and host styling

`src/main.ts` is the only source file directly under `src/` and remains a thin build entry. Static plugin CSS belongs to `src/obsidian/styles/`, tests mirror source ownership under `test/`, and generated release files remain under ignored `dist/`. Empty architecture folders are not created before they own real implementation.

React is restricted to the toolbar and application chrome. Lifecycle-owned adaptive panels and native Obsidian menus are outside React. The production build generates the complete activation runtime and its nested React editor-chrome and document-worker modules from checked-in TypeScript, compresses them, and embeds them in `main.js`; activation decodes owned modules locally without a network request. Pointer input, camera updates, snapping, culling, animation frames, and SVG reconciliation remain imperative hot paths. The exact dependency rules and folder topology are defined in [docs/specification.md](docs/specification.md#source-topology-and-module-boundaries). Runtime ownership and data flows are visualized in [docs/architecture-flows.md](docs/architecture-flows.md), and the public Obsidian boundary is defined in [docs/obsidian-integration.md](docs/obsidian-integration.md).

The production build is reproducible from the public source and uses ordinary esbuild and Terser minification. `scripts/build.mjs` gzip-compresses and Base91-encodes the generated activation runtime, React editor chrome, and document worker inside `main.js`. The small synchronous Obsidian entry decompresses the activation runtime and imports it through a locally owned Blob URL; the activation runtime loads the nested editor chrome and worker through the same local mechanism when needed. This is build-time packaging, not purpose-hiding obfuscation: the complete TypeScript entries remain in `src/`, no code is fetched from the network, and neither `eval` nor the `Function` constructor is used. Package verification rejects unresolved placeholders, missing runtime markers, source maps, and extra release artifacts without imposing an arbitrary JavaScript byte limit.

## GitHub automation

Pull requests targeting `main` require the exact checks `CI`, `Performance (shared)`, `Performance (refresh profiles)`, `gitleaks`, and `Validate PR Title`. CI and secret scanning run automatically only for those PRs; both retain manual dispatch. PR creation is restricted to repository collaborators. The final `CI` gate aggregates selected quality and performance work under the [CI acceptance contract](docs/quality-and-testing.md#coverage-and-ci-gates). An individual performance check returns successful no-work when its validated selection is empty; documentation-only changes leave both performance checks empty. All workflow actions are pinned to full commit SHAs, enforced by the repository policy, and remain tracked by Dependabot. The standalone gitleaks check scans the checked-out tree and commits introduced by the PR; manual scanner runs cover complete available history.

Dependabot checks npm and GitHub Actions every Monday at 08:00 Europe/Berlin. Minor and patch updates are grouped; only npm minor and patch updates become squash auto-merge eligible after required checks pass. npm major and all GitHub Actions updates require manual merging. The metadata-only automation checks the Dependabot actor and author, matching base/head repository, and nonfork source; only its merge job receives write permissions. CodeMirror peers are updated only together with the selected Obsidian API version because Obsidian requires exact compatible peer versions. A separate monthly workflow updates the checksum-pinned gitleaks CLI. Scheduled and manual scanner updates are serialized, skip an existing version branch or open update PR, and have a ten-minute job timeout. Failed update lookups block changes rather than being treated as absent updates.

## Releases

Obsidian requires a release tag identical to the manifest version, for example `0.1.0` without a leading `v`. A protected version tag must point to a commit on `main`. The release workflow reruns the complete quality gate and publishes `main.js`, `manifest.json`, and `styles.css` as GitHub Release assets.

## Security and privacy

Inkbook's first release is specified for local-only processing without accounts, telemetry, analytics, or network requests. Report vulnerabilities privately using [SECURITY.md](SECURITY.md).

## License status

This private repository is currently unlicensed and its package is marked `UNLICENSED`. Select and add a root `LICENSE` file before public distribution or submission to the Obsidian Community directory.
