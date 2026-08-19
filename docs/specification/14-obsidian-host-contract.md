# Obsidian Host Contract

## 1. Compatibility Baseline

Inkbook is a Community plugin whose canonical plugin ID is `inkbook` and whose display name is `Inkbook`. The production default export MUST extend Obsidian `Plugin`, implement asynchronous `onload()`, and release owned resources through `onunload()` and Obsidian `Component` ownership.

The initial compatibility baseline is `minAppVersion: "1.8.7"` and `isDesktopOnly: false`. The supported platforms are desktop and Android. Before every release, executable tests MUST prove that every imported Obsidian API exists and behaves as required on the declared minimum desktop and Android versions. Release notes record the exact Obsidian version, platform, OS build, device model or desktop hardware profile, imported API set, expected capability, and guarded fallback for every supported environment. An API introduced after the baseline requires a guarded equivalent fallback or an intentional minimum-version increase with an updated root `versions.json`.

## 2. Package and Manifest

The loadable plugin package contains these root artifacts:

```text
manifest.json
main.js
styles.css
```

`styles.css` is required because Inkbook supplies toolbar, stylebar, overlay, and selection styles. Source code is TypeScript, while `main.js` is a production bundle. Public Community distribution additionally requires a root `README.md`, a compatible `LICENSE`, and repository metadata required by the current submission rules. Sample-plugin scaffolding, development-only code, source maps containing local paths, and test fixtures MUST NOT enter the release package.

The production package is subject to the raw, compressed, embedded-worker, cold parse and evaluation, CSS, pre-`onload`, and peak-heap budgets in `ARTIFACT_BUDGET_V1` from [Quality and Performance](09-quality-and-performance.md). Measurement begins immediately before the host loads the plugin module and stylesheet, not at entry to `Plugin.onload()`. Top-level module evaluation may define constants and the plugin class only; it MUST NOT allocate a scene, instantiate a worker, enumerate the Vault, attach a view, or decode the embedded worker payload.

`manifest.json` MUST contain:

- `id: "inkbook"`, matching the installed plugin folder;
- `name: "Inkbook"`;
- an English `description` of at most 250 characters that starts with an action-oriented product statement, ends with a period, uses correct trademark capitalization, and contains no emoji or special decoration;
- a SemVer `version` in `x.y.z` form;
- `minAppVersion: "1.8.7"` unless a reviewed compatibility decision changes it;
- `isDesktopOnly: false`;
- a real `author` supplied by the publisher before packaging;
- a validated optional `authorUrl` only when supplied by the publisher;
- `fundingUrl` only when the publisher actually accepts financial support through the named target.

The immutable plugin ID uses lowercase ASCII letters and hyphens only, does not contain `obsidian`, does not end in `plugin`, and is checked for Community-directory uniqueness before submission. The display name uses permitted Basic Latin characters, includes neither `Obsidian` nor `Plugin`, and is checked for uniqueness. The package validator MUST reject an ID-folder mismatch, missing required property, non-SemVer version, release-tag mismatch, or an Android-compatible bundle containing Node.js or Electron code.

## 3. Startup, Ownership, and Disposal

`onload()` performs only bounded settings loading and lightweight registration. It registers commands, the imperative settings tab, one editor extension definition, Markdown post-processing, and lifecycle listeners. It MUST NOT scan the Vault, enumerate sidecars, parse large files, open workers, measure every view, or construct a scene during startup.

Layout-dependent initialization and Vault `create` observation begin through `workspace.onLayoutReady()` or an equivalent lazy boundary. Because `onLayoutReady()` has no disposer, its callback captures a plugin lifecycle token and checks it before every side effect, resource registration, and asynchronous continuation. `onunload()` invalidates that token before disposing children. A create-event handler invoked before layout readiness MUST return without expensive work. Sidecar and recovery work begins only when an annotated Markdown note is opened, the user invokes an explicit maintenance command, or a visible recovery state requires it.

Every resource owner MUST be an Obsidian `Component` or be attached to one with `addChild()`. Parent disposal removes children before releasing parent state. Host events use `registerEvent()`, DOM events use `registerDomEvent()`, intervals use `registerInterval()`, and resources without a host registrar have one idempotent explicit disposer. This includes timeouts, animation frames, observers, pointer capture, framework roots, workers, message ports, caches, and note-session leases.

Production code MUST NOT use global `app`, `window.app`, or a process-global mutable plugin instance. Adapters receive the owning plugin or `App` reference explicitly. View-owned DOM, events, animation frames, and timers use the concrete element's Obsidian `element.doc` and `element.win` helpers, not global `document`, global `window`, `activeDocument`, or whichever window is currently active.

## 4. Native Workspace and View Boundaries

Inkbook augments only Obsidian's native Markdown Live Preview, Source, and Reading View surfaces. It MUST NOT register an `ItemView`, custom view type, annotation leaf, Bases view, or replacement Markdown editor. It MUST NOT call `registerView()` or change a leaf with `setViewState()` to display annotation content. Bases files and non-Markdown leaves receive no toolbar, overlay, sidecar discovery, or YAML marker.

One view adapter is keyed by the concrete workspace leaf and host Markdown view instance. Leaf detach, host-view replacement, file change, mode change, or plugin unload disposes that adapter completely before any replacement adapter binds. Linked panes share a canonical note session only when they resolve the same Markdown file identity; they never share selection, viewport, zoom, DOM, focus, or transient gesture state.

Obsidian may defer a leaf's view. Passive discovery MUST check `WorkspaceLeaf.isDeferred` and skip a deferred leaf without calling `loadIfDeferred()` or `revealLeaf()`. Production code MUST NOT import or use `instanceof` against a non-public `DeferredView` class. An explicit user command that requires the view MAY await `workspace.revealLeaf()`, recheck the resulting view and file identity, then act. Direct `loadIfDeferred()` is allowed only behind a compatibility adapter when the documented user action cannot be implemented otherwise, and its use and latency MUST be measured.

When a Markdown view migrates into or out of a desktop pop-out window, the adapter handles `HTMLElement.onWindowMigrated()`, releases old-window resources, and rebinds or remounts against the new `element.doc` and `element.win`. Cross-window type checks use `element.instanceOf()` and `event.instanceOf()`, never native `instanceof` against main-window constructors. Android does not need to emulate pop-out windows, but desktop split and pop-out behavior is release-tested.

## 5. Editor and CodeMirror Contract

Native Markdown content is read and changed through the supplied Obsidian `Editor`. An editor command uses `editorCallback` or `editorCheckCallback` and the callback's actual `Editor` and `MarkdownView`; it never looks up a globally active editor. `checkCallback` and `editorCheckCallback` repeat capability checks in both invocations, keep `checking: true` side-effect-free, and mutate only when `checking` is false.

Command descriptors are registered during `onload()`. Public commands ship without default hotkeys unless a reviewed exception proves no practical conflict. Command IDs are stable ASCII identifiers without a redundant plugin-ID prefix. If a default letter hotkey is ever approved, it uses Obsidian's `Mod` abstraction and an uppercase key. Toolbar ordering is settings state and MUST NOT depend on command registration order.

CodeMirror is Obsidian's editor engine and remains owned by Obsidian. Inkbook creates no Markdown editor, `EditorView`, document state, native selection, or replacement history. Its narrow adapter extension is registered once with `registerEditorExtension()`. Each concrete Obsidian-owned `EditorView` creates its own bounded Inkbook `ViewPlugin` value and destroys it with that view. View updates read the post-transaction viewport, coalesce projection requests to at most one per animation frame, and query only visible ranges plus versioned bounded overscan. They MUST NOT force CodeMirror to mount offscreen content or scan the full scene.

Any access to a host editor property that Obsidian does not type publicly, such as `editor.cm`, is confined to one adapter. That adapter uses exactly one narrowly scoped `@ts-expect-error`, validates the runtime shape, returns a typed result or an unavailable result, and is contract-tested on every supported Obsidian version. `any`, `@ts-ignore`, and leaked CodeMirror types outside the adapter are forbidden.

CodeMirror state fields contain only small immutable view-local markers. Their `create()` and `update()` functions are pure, process effects in transaction order, and perform no DOM work, note-session mutation, application dispatch, or unbounded computation. External projection messages carry view identity plus editor, layout, and scene revisions and enter through typed `StateEffect` dispatch. Stale effects are ignored. External code MUST NOT mutate a field or view-plugin value directly.

On a release-supported editable CM6 surface, one annotation operation contributes one isolated invertible effect to the concrete editor's existing history without changing Markdown. Inkbook installs no second `history()` extension, replacement history keymap, or annotation-only Undo and Redo command. The bridge uses bounded immutable payloads, isolates text groups across an annotation boundary, and forwards effect intents in order to the originating `NoteSession`. Toolbar and platform Undo and Redo use this same host-history path. Unsupported, stale, malformed, disposed, or recovery-blocked bridge state fails annotation mutation closed. This contract is proven on every supported environment before release; no private-history or separate-stack fallback is permitted.

Editor decorations are viewport-neutral. They MAY expose lightweight markers or measurement probes, but MUST NOT replace or hide authored Markdown, add line breaks, alter vertical document layout, or retain canonical SVG scene state. Viewport-bounded decorations belong to the per-view plugin. A state field is used outside the viewport only for a documented small marker set or a measured layout probe.

## 6. Reading View Contract

Reading View uses `registerMarkdownPostProcessor()` and reads only rendered HTML for the section being processed. Rendered DOM order is neither a source-range authority nor a lifecycle oracle. Source relationships come from documented `MarkdownPostProcessorContext` data and validated bounded mapping evidence.

Each callback adds one `MarkdownRenderChild` through `context.addChild()` for section-owned observers and background regions. The whole-note overlay remains owned by the concrete Reading View coordinator. Reprocessing replaces the affected section generation without duplicating the overlay. Inkbook registers no Markdown code-block processor and never replaces authored rendered content.

The supported-version probe MUST verify callback granularity, section source mapping, reprocessing, child teardown, and whole-view disposal. Missing trustworthy source evidence produces the degraded read-only placement defined in [Anchors and Layout](05-anchors-and-layout.md), never a guessed binding.

Reading View is presentation-only in V1. Every toolbar, stylebar, handle, context-menu, clipboard, hotkey, and command entry point revalidates the concrete host mode immediately before dispatch. Mutation controls are disabled or omitted with an accessible read-only explanation. No Reading View interaction publishes an annotation operation, mutates Markdown, appends history, or enqueues sidecar work.

## 7. Host-Native User Interface

Annotation menus use Obsidian `Menu`. Pointer invocation uses `showAtMouseEvent()`. Keyboard or touch invocation uses `showAtPosition(position, ownerDocument)` with coordinates expressed relative to the originating element's window. Native Markdown context menus remain untouched when Inkbook does not own the target.

Each supported Markdown view owns one bounded Inkbook toolbar host and one independent note-header Show or Hide toggle for the complete concrete-view lifetime. The toggle is plugin-owned safe DOM inside that view, remains mounted and operable while the expanded toolbar is hidden, and never uses a Ribbon action or persistent status-bar item as its only entry point. Collapsing changes view-local presentation only. It MUST NOT dispose the host, annotation overlay, selection, scene subscription, or active tool state. View disposal removes the toggle, toolbar, stylebar, framework root, and subscriptions together and exactly once.

Recovery, conflict, and destructive decisions use Obsidian `Modal` or an accessibility-equivalent host-native modal. Opening a modal does not mutate state. Escape and Cancel preserve the prior state. A chosen action closes the modal before invoking its at-most-once command, and focus returns predictably.

Production DOM is built with safe APIs such as `createEl()`, `createDiv()`, `createSpan()`, attributes, and `textContent`. `innerHTML`, `outerHTML`, `insertAdjacentHTML`, raw authored SVG strings, and untrusted HTML parsing are forbidden. A container uses `empty()` or its owned-node disposer before rerendering.

Icons use Obsidian `setIcon()` for current supported Lucide IDs or `addIcon()` for uniquely prefixed static plugin SVG. Custom icon markup contains no user data, URLs, scripts, styles, or event attributes, fits the API's `0 0 100 100` view box, and follows the documented Lucide geometry guidelines. Icon size follows Obsidian's `--icon-size`. The selected icons are validated against the minimum and release Obsidian versions rather than pinning assumptions to an unrelated Lucide release.

All production CSS is namespaced beneath an Inkbook class and uses Obsidian theme variables. Layout uses logical properties. Inkbook observes host right-to-left state without mutating it, honors `.markdown-source-view[dir]`, per-line direction in mixed editor content, and Reading View `dir="auto"`. Text controls use `unicode-bidi: plaintext` where appropriate. Inkbook relies on Obsidian's automatic RTL icon mirroring and unsets the host transform only for an icon whose meaning is physically fixed.

V1 adds neither a Ribbon action nor a persistent Obsidian status-bar item. Android does not expose the desktop status bar consistently, and neither surface is required for the in-note workflow. Save, conflict, recovery, and inference states use bounded view-scoped visible text and an accessible live region owned by the originating view.

## 8. Settings Contract

The 1.8.7 baseline uses one imperative `PluginSettingTab.display()` built from Obsidian `Setting` controls. It MUST NOT require `getSettingDefinitions()`, which is available only from Obsidian 1.13.0. A future migration either raises `minAppVersion` and uses only declarative settings or maintains explicitly tested dual implementations. The two implementations MUST never expose different semantics.

Settings are loaded, migrated, and fully validated before the tab is registered or a view consumes them. UI validation is not the trust boundary. `loadData()` returns untrusted nullable data. `saveData()` acknowledgement is required before durability is claimed. The 1.8.7 baseline provides no assumed public plugin-data change event. If a supported host cell exposes a verified external-settings signal, one guarded adapter reloads and atomically publishes a complete validated snapshot. Otherwise Inkbook reloads only at plugin load and settings-tab reopen, performs no polling, and makes no live-sync claim. Invalid reloaded data retains the last valid snapshot and shows Retry.

The toolbar Settings control uses one guarded host-settings adapter. When a tested public capability can open Inkbook's registered tab, the adapter MAY use it. Otherwise it shows an accessible host-native instruction for navigating to Inkbook in Settings. It MUST NOT access untyped global settings internals.

Device-local preferences use a validated adapter over `App.loadLocalStorage()` and synchronous `App.saveLocalStorage()`. They are Vault-local on that device, may throw, are not transactional, and MUST NOT be described as globally device-wide or synchronized. A failed write keeps the session value active but explicitly non-durable.

Toolbar-order settings have fixed membership. The settings tab exposes Move up, Move down, and Reset actions for keyboard and touch; drag is supplementary. Top-level setting labels use sentence case and do not add a redundant `General` heading. V1 stores no secrets. A future secret MUST use Obsidian `SecretStorage` and `SecretComponent`, never plugin data, local storage, sidecars, diagnostics, or logs.

The plugin-global sidecar storage policy is either adjacent or one validated visible Vault-relative root. The settings tab exposes the conditional root field, exact path preview, and a separate confirmed migration action. Saving the default never performs a Vault scan or moves an existing file. Existing notes follow their validated YAML locator until migrated. Invalid values retain the last valid policy and create no folder or sidecar.

A host rename of the configured root validates and persists the replacement policy through `saveData()` before new sidecar creation resumes. Failure keeps a visible session-only replacement with Retry, blocks creation under old and new roots, and never recreates the old root implicitly.

## 9. Vault Contract

All note and sidecar access uses Obsidian `Vault`, `FileManager`, `TFile`, and the documented `TFolder` branch for folder events. Constructed Vault paths pass through `normalizePath()`. Absolute, traversing, hidden, `.obsidian`, and outside-Vault sidecar locations, direct file-system paths, and adapter internals are forbidden. Every `TAbstractFile` event value is narrowed to the required concrete type. File-only stat, read, process, rename, and trash operations require `TFile`; a Vault rename additionally handles `TFolder` so affected plugin-owned path identities, storage roots, and YAML locators are rekeyed without a startup or implicit Vault-wide scan.

Current-file and locator lookup use a known `TFile` or `getFileByPath()`. The YAML locator is validated as untrusted evidence and never authorizes a sidecar whose embedded Markdown identity does not match the concrete note. A Markdown digest mismatch is freshness evidence and enters bounded external reattachment or conflict handling rather than locator rejection. An explicit orphan-sidecar review or confirmed location migration uses `vault.getFiles()`, filters the exact `.inkbook.json` suffix, applies a candidate limit while scanning, and yields in bounded slices. It MUST NOT use `getMarkdownFiles()` for sidecars or perform a startup-wide scan. Hidden-folder sidecars are unsupported in V1.

An existing sidecar save first obtains its bounded comparison base with `cachedRead()` or the exact raw value retained from the last acknowledged load. Encoding occurs asynchronously. The final compare-and-replace uses `Vault.process()` and performs only a byte-for-byte base comparison plus return of the prepared encoding inside its synchronous callback. It does not await, hash, parse, validate, or call another Vault method in that callback. The exact comparison follows the calibrated writable-size and worst-case main-thread benchmark in [Sidecar Persistence](07-sidecar-persistence.md); a platform that fails it opens larger valid files read-only rather than weakening conflict detection.

Trash behavior uses the host trash contract through `FileManager.trashFile()` or its version-compatible equivalent. Inkbook never calls permanent `Vault.delete()` as a fallback. Rename, create, delete, and modify listeners are owned registrations and tolerate rename, sync, and save races as specified in [Sidecar Persistence](07-sidecar-persistence.md).

## 10. Android and Worker Compatibility

The production and transitive Android-compatible bundle MUST contain no Node.js built-ins, Electron imports, native modules, or unconditional desktop globals. Platform branches use Obsidian `Platform` capabilities and are exercised on real Android devices. Desktop mobile emulation is supplementary evidence only.

Runtime syntax is compiled for the selected Android baseline. RegExp lookbehind is forbidden unless every supported Android target proves it and a tested fallback exists. Touch behavior has no hover dependency, every required action has a 44 by 44 CSS-pixel target, and software-keyboard text entry remains native Obsidian behavior.

V1 worker source is included as a build-time static payload in `main.js` and launches through one Phase-0-proven desktop and Android adapter. No additional release artifact is assumed. The adapter proves that its local URL or Blob mechanism is permitted by every supported host, revokes temporary URLs during disposal, and falls back to the bounded slices in [SVG Rendering](06-svg-rendering.md) when workers are unavailable. Workers never import Obsidian host APIs or receive mutable canonical buffers.

V1 recovery uses the transactional IndexedDB adapter selected in [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md). The Phase 0 production-shaped probe MUST exercise creation, transaction commit and abort, quota failure, restart, corruption, exact cleanup, and disposal in every compatibility cell. Inkbook MUST NOT substitute synchronous local storage, plugin JSON, or Vault files when IndexedDB is unavailable or non-conforming; annotation mutation remains read-only with truthful status.

## 11. Public Release and Community Directory

Public distribution is blocked until the current Community plugin policies and submission requirements are rechecked. The repository and README MUST state capabilities, local data flow, sidecar behavior, Android support, network absence, compatibility limits, known risks, licensing, and independent third-party status accurately. The implementation MUST not obfuscate behavior, self-install, self-update, download executable code, or claim endorsement by Obsidian.

For every public release:

1. the manifest version, exact Git tag, and release version match;
2. the lockfile-based production build, type check, tests, audits, Android-bundle check, and package validation pass;
3. `main.js`, `manifest.json`, and `styles.css` are attached to the release;
4. `versions.json` is updated whenever `minAppVersion` changes and its fallback selection is tested;
5. a draft release is reviewed before publication;
6. Community directory metadata and ownership records are updated through the documented directory workflow when applicable.

The first present package script in the Community scanner order `build`, `build:plugin`, `compile` MUST execute the production plugin build. No earlier script in that order may emit a development artifact or bypass package validation.

The GitHub Actions release workflow and repository controls follow [GitHub and CI](17-github-and-ci.md). Supply-chain-sensitive actions are pinned to reviewed immutable commit digests and updated through Dependabot. Signed artifact attestations are used when the adopted release workflow and repository permissions support them.

Official beta-testing distribution is outside the V1 release requirement. If later adopted, beta versions, channels, and user warnings require a separate reviewed contract. Organization ownership is likewise conditional on the actual publisher and MUST NOT be invented.

## 12. Verification Ownership

The adapter contracts and release cases in this document are tested by [Testing and Acceptance](10-testing-and-acceptance.md). Performance counters and package gates are owned by [Quality and Performance](09-quality-and-performance.md). The official pages used for this contract and pages reviewed as intentionally inapplicable are recorded in [References](13-references.md).
