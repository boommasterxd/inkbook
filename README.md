# Inkbook

Inkbook is an Obsidian plugin for creating and editing responsive handwriting embeds stored as self-contained SVG files. It is designed for low-latency pen, touch, and mouse input while preserving a portable static preview outside the plugin.

## Project status

The repository is ready for implementation, but the editor itself is not implemented yet. The current code provides a minimal desktop-and-mobile-compatible Obsidian plugin entry point, a production build, one host-boundary Integration test, strict quality gates, dependency automation, secret scanning, and release automation.

The first release is specified to include:

- pen, highlighter, straight highlighter, eraser, selection, and lasso tools
- lines, arrows, closed shapes, coordinate systems, and configurable tables
- layer ordering within fixed render bands
- shape-anchor snapping with persistent line and arrow connections
- backgrounds, page expansion, zoom, clipboard actions, and command history
- locked SVG previews across tabs, panes, and pop-out windows with one active editor per workspace
- responsive interaction with the required 10,000-stroke acceptance dataset

These are specification targets, not claims about the current scaffold. See [docs/specification.md](docs/specification.md) for the normative scope and [docs/quality-and-testing.md](docs/quality-and-testing.md) for acceptance budgets.

## Requirements

- Node.js 24
- npm
- Obsidian 1.13.0 or newer

## Development

```sh
npm ci
npm run dev
```

Development and production output is written to `dist/`. Copy its contents, or link the directory, to `<vault>/.obsidian/plugins/inkbook`, then reload Obsidian and enable Inkbook under Community plugins.

Useful commands:

| Command                  | Purpose                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| `npm run dev`            | Watch source and emit a development build with inline source maps.          |
| `npm run build`          | Create the minified production plugin package under `dist/`.                |
| `npm test`               | Run all currently implemented automated tests.                              |
| `npm run test:coverage`  | Run tests with the 85 percent executable-source line threshold.             |
| `npm run lint`           | Enforce Obsidian, architecture, size, complexity, and mobile-runtime rules. |
| `npm run typecheck`      | Type-check plugin source separately from Node-based test tooling.           |
| `npm run ci`             | Run every local gate used by the required GitHub `CI` check.                |
| `npm run benchmark`      | Verify the deterministic production-bundle size budget.                     |
| `npm run package:verify` | Verify versions and the exact Obsidian release-artifact envelope.           |

The complete gate also checks formatting, duplication, dead code, dependency vulnerabilities, coverage, the production build, and package contents.

## Architecture

The target implementation follows five dependency-directed responsibility areas:

- `domain`: pure elements, geometry, commands, schemas, and spatial data
- `editor`: input arbitration, gestures, selection, sessions, and autosave scheduling
- `rendering`: React application chrome and the separate imperative SVG scene
- `persistence`: document codecs, migrations, worker tasks, and save orchestration
- `obsidian`: plugin lifecycle, embeds, settings, host adapters, and host styling

`src/main.ts` is the only source file directly under `src/` and remains a thin build entry. Static plugin CSS belongs to `src/obsidian/styles/`, tests mirror source ownership under `test/`, and generated release files remain under ignored `dist/`. Empty architecture folders are not created before they own real implementation.

The exact dependency rules and target folder topology are defined in [docs/specification.md](docs/specification.md#source-topology-and-module-boundaries). Runtime ownership and data flows are visualized in [docs/architecture-flows.md](docs/architecture-flows.md), and the public Obsidian boundary is defined in [docs/obsidian-integration.md](docs/obsidian-integration.md).

## GitHub automation

Every pull request requires the exact checks `CI`, `gitleaks`, and `Validate PR Title`. All workflow actions are pinned to full commit SHAs and remain tracked by Dependabot.

Dependabot checks npm and GitHub Actions every Monday at 08:00 Europe/Berlin. Minor and patch updates are grouped and become squash auto-merge eligible only after required checks pass. Major updates remain separate for manual review. CodeMirror peers are updated only together with the selected Obsidian API version because Obsidian requires exact compatible peer versions. A separate monthly workflow updates the checksum-pinned gitleaks CLI.

## Releases

Obsidian requires a release tag identical to the manifest version, for example `0.1.0` without a leading `v`. A protected version tag must point to a commit on `main`. The release workflow reruns the complete quality gate and publishes `main.js`, `manifest.json`, and `styles.css` as GitHub Release assets.

## Security and privacy

Inkbook's first release is specified for local-only processing without accounts, telemetry, analytics, or network requests. Report vulnerabilities privately using [SECURITY.md](SECURITY.md).

## License status

This private repository is currently unlicensed and its package is marked `UNLICENSED`. Select and add a root `LICENSE` file before public distribution or submission to the Obsidian Community directory.
