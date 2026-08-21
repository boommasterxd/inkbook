# Inkbook

Inkbook is an Obsidian plugin for creating and editing responsive handwriting embeds stored as self-contained SVG files. The repository currently provides the implementation specification, a minimal mobile-compatible plugin entry point, and the quality and release tooling needed to start implementation.

## Requirements

- Node.js 24
- npm
- Obsidian 1.13.0 or newer

## Development

```sh
npm ci
npm run dev
```

The development build is written to `dist/`. Copy or link that directory to `<vault>/.obsidian/plugins/inkbook`, then reload Obsidian and enable Inkbook under Community plugins.

Run the complete local quality gate before opening a pull request:

```sh
npm run ci
```

The gate verifies formatting, lint rules, type safety, focused Unit and Integration tests with coverage, duplication, dead code, dependency security, the production build, the bundle-size budget, and the release package.

## Architecture and specification

The normative implementation contract starts in [docs/specification.md](docs/specification.md). Runtime ownership and flows are visualized in [docs/architecture-flows.md](docs/architecture-flows.md), and the Obsidian host boundary is defined in [docs/obsidian-integration.md](docs/obsidian-integration.md).

Source code follows the five responsibility areas documented in the specification: `domain`, `editor`, `rendering`, `persistence`, and `obsidian`. Only the Obsidian adapter exists in the initial scaffold; additional directories should be introduced when they contain real implementation code.

```text
src/
├── main.ts
└── obsidian/
    ├── inkbook-plugin.ts
    └── styles/
        └── inkbook.css
```

## Releases

Obsidian requires a release tag identical to the manifest version, for example `0.1.0` without a leading `v`. The release workflow verifies the full quality gate and publishes `main.js`, `manifest.json`, and `styles.css` as GitHub Release assets.

## Security and privacy

Inkbook's first release is specified for local-only processing without accounts, telemetry, analytics, or network requests. Report vulnerabilities using [SECURITY.md](SECURITY.md).

## License status

This private repository is currently unlicensed and its package is marked `UNLICENSED`. Select and add a root `LICENSE` file before public distribution or submission to the Obsidian Community directory.
