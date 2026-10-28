# Contributing

## Workflow

1. Create a working branch from `main`.
2. Make focused changes that preserve the architecture and contracts under `docs/`.
3. Run focused checks during implementation and complete the verification required for the change type once the result is stable, following [Testing and Acceptance](AGENTS.md#testing-and-acceptance).
4. Open a pull request with a Conventional Commits title such as `feat(editor): add pen gesture state`.
5. Merge through squash only after all required checks pass.

Do not commit generated `main.js`, `dist/`, coverage output, dependencies, secrets, or local vault data.

Use `npm run ci` when complete local quality and performance verification is required. Documentation-only changes follow the content, link, fence, and index checks in the linked acceptance contract.

## Quality requirements

- Keep runtime code compatible with desktop and mobile Obsidian. Node.js and Electron APIs are build-tool-only and forbidden under `src/`.
- Keep functions at or below 100 lines, files at or below 500 lines, cyclomatic complexity at or below 20, cognitive complexity at or below 25, parameters at or below 6, and nesting depth at or below 4.
- Maintain the [coverage thresholds and scope](docs/quality-and-testing.md#coverage-and-ci-gates): at least 85 percent for lines, statements, and functions, and 80 percent for branches.
- Add Unit tests for pure behavior and focused Integration tests for important adapters. Do not add End-to-End or smoke suites.
- Keep technical content, code, identifiers, configuration, tests, commits, pull requests, and reports in English.

See [AGENTS.md](AGENTS.md) for the complete project rules and documentation index.
