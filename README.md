# Inkbook

Inkbook is a mobile-capable Obsidian plugin for high-performance retained SVG annotations on native Markdown notes. Obsidian continues to own Markdown editing and history. Inkbook stores annotation data in validated sidecar files and projects annotations over Live Preview, Source mode, and Reading View.

The repository is currently private and in Phase 0 feasibility work. The product specification is authoritative. The adjacent annotation project mentioned in the specification is not an implementation input.

## Development

Requirements:

- Node.js 24 active LTS, within the range declared in `package.json`;
- npm 12 within the declared range;
- a dedicated non-production Obsidian test Vault.

Install and verify:

```sh
npm ci
npm run ci
```

Create a production package locally:

```sh
npm run build
npm run package:check
```

The loadable plugin artifacts are `main.js`, `manifest.json`, and `styles.css`. Generated `main.js` and root `styles.css` are release artifacts and are not committed.

## Privacy and Network Use

The intended runtime is local-only. Inkbook does not require an account, telemetry, advertising, remote code, or network access. Annotation sidecars may be synchronized by the user's selected Obsidian or filesystem synchronization mechanism. Users remain responsible for the privacy and conflict behavior of that mechanism.

## License

This project is source-available but is not open source. Reading and limited private use are permitted only under [LICENSE.md](LICENSE.md). Modification, public redistribution, and derivative works are not permitted unless the copyright holder grants separate written permission.

## Security

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md).
