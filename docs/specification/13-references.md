# References

## Official Obsidian Documentation Review

The complete 47-page navigation set supplied for this review was checked page by page on 2026-08-17. Three directly relevant current reference pages outside that supplied navigation excerpt were also checked. The review used the English documentation repository at commit `c56c7e770ba25dd0ea392aacf4588f9425970d36` and the corresponding public pages. Every page was assigned to an independent read-only evidence review before the findings were integrated into this specification.

### Documentation Home

- [Home](https://docs.obsidian.md/Home)

### Community Directory

- [Community directory](https://docs.obsidian.md/community-directory)
- [Set up and claim](https://docs.obsidian.md/community-directory/set-up-and-claim)
- [Manage your plugin or theme](https://docs.obsidian.md/community-directory/manage-entry)
- [Developer policies](https://docs.obsidian.md/community-directory/developer-policies)
- [Submission requirements for plugins](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)
- [Organizations](https://docs.obsidian.md/community-directory/organizations)
- [Frequently asked questions](https://docs.obsidian.md/community-directory/faq)

### Plugin Getting Started

- [Build a plugin](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin)
- [Anatomy of a plugin](https://docs.obsidian.md/Plugins/Getting+started/Anatomy+of+a+plugin)
- [Development workflow](https://docs.obsidian.md/Plugins/Getting+started/Development+workflow)
- [Mobile development](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development)
- [Use React in your plugin](https://docs.obsidian.md/Plugins/Getting+started/Use+React+in+your+plugin)
- [Use Svelte in your plugin](https://docs.obsidian.md/Plugins/Getting+started/Use+Svelte+in+your+plugin)

### Plugin Guides

- [Build a Bases view](https://docs.obsidian.md/plugins/guides/bases-view)
- [Defer views](https://docs.obsidian.md/plugins/guides/defer-views)
- [Manage plugin lifecycle](https://docs.obsidian.md/plugins/guides/lifecycle-management)
- [Optimize plugin load time](https://docs.obsidian.md/plugins/guides/load-time)
- [Store secrets](https://docs.obsidian.md/plugins/guides/secret-storage)
- [Support pop-out windows](https://docs.obsidian.md/plugins/guides/pop-out-windows)

### User Interface

- [About user interface](https://docs.obsidian.md/Plugins/User+interface/About+user+interface)
- [Commands](https://docs.obsidian.md/Plugins/User+interface/Commands)
- [Context menus](https://docs.obsidian.md/Plugins/User+interface/Context+menus)
- [HTML elements](https://docs.obsidian.md/Plugins/User+interface/HTML+elements)
- [Icons](https://docs.obsidian.md/Plugins/User+interface/Icons)
- [Modals](https://docs.obsidian.md/Plugins/User+interface/Modals)
- [Ribbon actions](https://docs.obsidian.md/Plugins/User+interface/Ribbon+actions)
- [Right-to-left](https://docs.obsidian.md/Plugins/User+interface/Right-to-left)
- [Settings](https://docs.obsidian.md/Plugins/User+interface/Settings)
- [Status bar](https://docs.obsidian.md/Plugins/User+interface/Status+bar)
- [Views](https://docs.obsidian.md/Plugins/User+interface/Views)
- [Workspace](https://docs.obsidian.md/Plugins/User+interface/Workspace)

### Editor

- [Editor](https://docs.obsidian.md/Plugins/Editor/Editor)
- [Markdown post processing](https://docs.obsidian.md/Plugins/Editor/Markdown+post+processing)
- [Editor extensions](https://docs.obsidian.md/Plugins/Editor/Editor+extensions)
- [Decorations](https://docs.obsidian.md/Plugins/Editor/Decorations)
- [State fields](https://docs.obsidian.md/Plugins/Editor/State+fields)
- [State management](https://docs.obsidian.md/Plugins/Editor/State+management)
- [View plugins](https://docs.obsidian.md/Plugins/Editor/View+plugins)
- [Viewport](https://docs.obsidian.md/Plugins/Editor/Viewport)
- [Communicating with editor extensions](https://docs.obsidian.md/Plugins/Editor/Communicating+with+editor+extensions)

### Releasing

- [Release your plugin with GitHub Actions](https://docs.obsidian.md/Plugins/Releasing/Release+your+plugin+with+GitHub+Actions)
- [Submit your plugin](https://docs.obsidian.md/plugins/releasing/submit-plugin)
- [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [Beta-testing plugins](https://docs.obsidian.md/Plugins/Releasing/Beta-testing+plugins)

### Events and Vault

- [Events](https://docs.obsidian.md/Plugins/Events)
- [Vault](https://docs.obsidian.md/Plugins/Vault)

### Additional Current References

- [CodeMirror inverted effects example](https://codemirror.net/examples/inverted-effect/), for adding non-document effects to the existing editor history.
- [CodeMirror commands reference](https://codemirror.net/docs/ref/#commands.invertedEffects), for `invertedEffects`, `isolateHistory`, and the host history contract.
- [Migrate to declarative settings](https://docs.obsidian.md/plugins/guides/migrate-declarative-settings)
- [Manifest reference](https://docs.obsidian.md/Reference/Manifest)
- [Versions reference](https://docs.obsidian.md/Reference/Versions)

## Review Disposition

The resulting binding requirements are owned by [Obsidian Host Contract](14-obsidian-host-contract.md) and the linked subject documents. Pages about Bases, custom views, Ribbon actions, persistent status-bar items, secret storage, Svelte, organization ownership, and beta distribution were not ignored. They were reviewed and resolved as explicit V1 exclusions, conditional future paths, or negative compatibility requirements.

The React guide informs lifecycle and root-disposal requirements because the current architecture selects React only for coarse UI. The Svelte guide confirms that framework-specific host integration is optional and does not justify a second framework. The declarative-settings guide is future-facing because the current minimum Obsidian version remains below 1.13.0.

## Additional Primary References

- [Dependabot options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference), for schedules, grouping, labels, and semantic update types.
- [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets), for pull-request, status-check, force-push, deletion, and bypass controls.
- [Troubleshooting required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks), for required-workflow trigger and permanently pending check behavior.
- [Secure use reference for GitHub Actions](https://docs.github.com/en/actions/reference/security/secure-use), for least privilege and immutable full-SHA action references.
- [GitHub Actions artifact management](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/remove-workflow-artifacts), for bounded retention and explicit deletion of temporary workflow artifacts.
- [GitHub releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases), for tag-based release assets and release metadata.
- [Obsidian API type definitions](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts), for exact exported host types and API availability checks.
- [Sync selective syncing](https://obsidian.md/help/sync/settings), including synchronization of other file types and plan file-size limits.
- [Sync conflict behavior](https://obsidian.md/help/sync/troubleshoot), for external last-modified conflict behavior.
- [HTML Living Standard, Web workers](https://html.spec.whatwg.org/multipage/workers.html), for dedicated-worker lifecycle and messaging.
- [RFC 8785, JSON Canonicalization Scheme](https://datatracker.ietf.org/doc/html/rfc8785), for deterministic JSON serialization and hashable canonical bytes.
- [Unicode Standard Annex 15](https://www.unicode.org/reports/tr15/), for NFC normalization of bounded anchor evidence without normalizing authored Markdown.
- [Indexed Database API 3.0](https://w3c.github.io/IndexedDB/), for the transactional device-local recovery adapter selected for V1.
- [Clipboard API and events](https://www.w3.org/TR/clipboard-apis/), for bounded clipboard integration and host capability constraints.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/), for accessibility acceptance criteria.
- [React Profiler](https://react.dev/reference/react/Profiler), for measured coarse-UI commit and render-count evidence.
- [React `useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore), as an implementation option for narrow immutable subscriptions.

## Historical Inkbook References

The previous standalone Inkbook specifications and UI mockup were used only for still-applicable visual and interaction requirements, especially the toolbar, contextual stylebar, tool set, selection handles, style controls, pressure behavior, and code-quality gates. Standalone-only concepts are explicitly excluded in [Product Scope](01-product-scope.md).

## Reverification

Obsidian APIs, policies, minimum versions, Android behavior, directory procedures, and release examples are versioned external dependencies. The implementation MUST recheck the exact official pages and API types against the selected minimum and release versions before every public release. Samples are evidence, not permission to freeze old action, runtime, icon-library, or API versions indefinitely.
