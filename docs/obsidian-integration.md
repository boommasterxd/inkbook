# Obsidian Integration

## Authority and Support Surface

This document defines the host boundary for Inkbook. Domain, editor, rendering, and persistence code MUST depend on narrow adapters and MUST NOT import undocumented Obsidian internals.

Inkbook supports Obsidian desktop, iOS, and Android with `minAppVersion: "1.13.0"` and `isDesktopOnly: false`. Runtime code uses documented Obsidian APIs and browser APIs only. Node.js, Electron, `FileSystemAdapter`, `Vault.adapter`, the global `app` object, private workspace fields, and private CSS selectors are forbidden.

The required host behavior is:

| Obsidian mode | Inkbook behavior                                                                 | Public integration                                                                         |
| ------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Reading view  | Preserve the native static SVG preview and progressively add activation behavior | `Plugin.registerMarkdownPostProcessor()`                                                   |
| Live Preview  | Replace visible Inkbook embeds with viewport-bounded widgets                     | `Plugin.registerEditorExtension()` with a CM6 `ViewPlugin`, `Decoration`, and `WidgetType` |
| Source mode   | Preserve editable Markdown source; do not replace the embed text                 | Obsidian `Editor` for user-initiated text changes                                          |

Obsidian does not expose a dedicated public handler for native `![[file.svg]]` embeds. Reading-view enhancement therefore MUST be progressive. The postprocessor correlates a candidate through `MarkdownPostProcessorContext.sourcePath` and the section returned by `getSectionInfo()` immediately before use. It excludes code and preformatted descendants, requires exactly one recognized raw embed and one native image whose canonical `currentSrc || src` equals the resolved resource URL, and otherwise leaves the host DOM untouched. Before ownership, a bounded lazy classification through `Vault.cachedRead()` requires the canonical root-level `data-inkbook-format="inkbook"` marker. The postprocessor repeats its section and image correlation after the asynchronous classification and before adding its lifecycle child. If section information is `null`, the target cannot be resolved unambiguously, the marker is absent, or the generated DOM is unfamiliar, Inkbook leaves the native preview unchanged and does not unlock it. This fallback is safe and MUST be covered against every supported Obsidian version.

Live Preview decorations are produced only for visible ranges and only while `editorLivePreviewField` is active. A candidate is accepted only when the public CodeMirror syntax tree is available, an exact `Image` or embed node covers the complete candidate range, and the bounded document-classification cache confirms the Inkbook root marker. An unknown target starts one coalesced asynchronous classification and remains on Obsidian's native path until a lifecycle-owned CodeMirror effect refreshes the visible decorations. The cache retains at most 256 classifications and invalidates the relevant path on vault creation or modification. Escaped syntax, inline or fenced code, HTML comments, incomplete trees, unknown nodes, inexact ranges, and ordinary SVG files fail closed. Syntax-tree changes invalidate decorations, and widget equality includes both the resolved document path and resource URL. CodeMirror state and decorations MAY use CM6 transactions. Markdown text mutations MUST use the Obsidian `Editor` API, such as `Editor.replaceRange()`, so cursor, selection, folds, history, and mobile behavior remain host-managed.

Inkbook does not define a targetless `![[Inkbook]]` pseudo-embed. The Markdown continues to reference the standalone SVG so Obsidian can resolve, rename, render, and track the file without the plugin. Other image plugins retain ordinary SVGs because Inkbook mounts no DOM, listener, scrollbar lease, or CodeMirror replacement until the Inkbook marker is confirmed. Once confirmed, the locked preview image has no pointer target, and its owning button prevents and stops the activation click before opening or resizing the native image. Inkbook owns interaction inside its scoped root; external image tools MUST NOT be treated as part of the Inkbook lifecycle or editor state.

## Widget and Resource Ownership

Each Reading-view embed with listeners or UI owns one `MarkdownRenderChild`, registered through `MarkdownPostProcessorContext.addChild()`. Each Live Preview embed owns one `WidgetType` instance. Both attach the same editor session facade but own their presentation resources independently. One plugin-scoped `WorkspaceEditorCoordinator` is shared by the main window and every pop-out belonging to the same `App.workspace`.

Every widget unload path MUST immediately:

- cancel animation frames, UI timeouts, and pointer gestures, reverting uncommitted previews
- release pointer capture and remove document-level input listeners
- disconnect `ResizeObserver` and other observers
- revoke owned Blob URLs
- close menus and remove portals
- detach the canvas input surface and its context-menu, keyboard, wheel, and pointer handlers
- release its reference-counted native-scrollbar stability lease
- unmount the React root
- invalidate the widget-attachment generation so late UI work cannot mutate detached state

The widget then asks the coordinator to detach its session. A clean session terminates its worker and releases all state. A dirty or saving session keeps its worker epoch, active save, prepared successor, and export generation under the single detached-save lease defined in [Workspace Activation and Detachment](specification.md#workspace-activation-and-detachment); widget unload MUST NOT cancel that save. The lease owns no DOM, `Document`, `Window`, leaf, view, widget, React root, portal, observer, or input listener.

Plugin-wide host events use `registerEvent()`, persistent DOM listeners use `registerDomEvent()`, intervals use `registerInterval()`, and other cleanup uses `Component.register()`. Widget resources belong to the widget component rather than a global collection. The plugin main object MUST NOT retain leaves, views, widgets, React roots, or clean editor sessions after their component unloads. The coordinator may retain only the single dirty detached or headless recovery session until it reaches a confirmed terminal outcome.

Pop-out windows are supported. DOM creation, portals, menus, animation frames, and event registration use the owning embed's `ownerDocument` and `defaultView`, or Obsidian's `activeDocument` and `activeWindow` when no embed exists. They MUST NOT assume the main global `document` or `window`.

The production build emits a small synchronous Obsidian plugin entry and embeds the complete minified activation runtime as gzip-compressed, Base91-encoded bytes in `main.js`. That runtime contains separately compressed document-worker and React 18 editor-chrome modules. Loading uses only the owning window's standard `Blob`, `URL`, `Response`, and `DecompressionStream` APIs plus native dynamic `import()`; it performs no network request and creates no additional release artifact. The build permits only `obsidian`, `@codemirror/language`, `@codemirror/state`, and `@codemirror/view` as runtime host modules and fails if the generated runtime requires any other external module. One activation-runtime promise is shared per owning window, failed loads remain retryable, and temporary host-module exposure plus the Blob URL are removed when import settles. Plugin activation generations prevent a runtime or settings result from registering anything after unload or an intervening reload.

The nested editor-chrome module still has one load promise per owning window, while each presentation owns a distinct React root. Its Blob URL is revoked when module import settles, the final consumer cancels, or the five-second load bound expires. A detached presentation cancels its pending mount, retains only the latest coarse props while loading, and cannot mount after unload. Input, toolbar-dependent layout, and static-preview handoff remain disabled until the React root has mounted and the toolbar has been measured. A missing compression API, CSP rejection of an owned `blob:` module, decode error, import error, or timeout preserves the native static preview and creates no React root. This keeps React out of the initial execution and render paths while retaining a progressive fallback when a supported Web API or `blob:` module policy is unavailable.

Activation requests from all owning documents pass through the same coordinator and identify the normalized SVG document separately from the widget attachment and its generation. The coordinator contains no DOM reference. Its workspace tokens, one pending-request slot, and detached-save lease make rapid cross-window activation deterministic. Widget unload cancels a matching pending request before releasing resources. A recovery modal resolves its presentation document only when shown and never stores that window after close.

`onload()` first loads the owned activation runtime, then that runtime performs only settings loading and registration of commands, the settings tab, the postprocessor, and the editor extension. It performs no vault scan, SVG parse, React mount, or worker creation. Layout-dependent work and vault `create` listeners begin inside `workspace.onLayoutReady()`. Plugin unload invalidates the activation generation, cancels work, and rejects late runtime or settings results; it MUST NOT depend on an awaited asynchronous `onunload()`. Lock still awaits its save. Best-effort shutdown work MAY be registered with the workspace quit task mechanism.

## Native Scroll Owner and Scrollbar Stability

Inkbook never creates or owns a vertical scroll container. The presentation adapter resolves the nearest Obsidian scroll owner through the computed-overflow ancestor algorithm in [Zoom Functionality](zoom.md#anchored-zoom), using only the embed's `ownerDocument` and `defaultView`. It does not query a private Obsidian class or assume a main-window DOM shape.

After the public integration safely recognizes an Inkbook presentation and before Inkbook performs its first positive-width preview or editor measurement, that presentation acquires a reference-counted lease for the exact scroll element. Initial class acquisition is a write-only phase; Inkbook reads post-style width in the following animation frame and enables no editor input before that measurement settles. The lease applies one public Inkbook marker class that requests `scrollbar-gutter: stable` and `overflow-y: scroll` for the full recognized-presentation lifetime, including lock and unlock. This reserves the right-hand native scrollbar gutter before width-fit zoom and prevents activation or pen contact from changing the content width. Multiple Inkbook presentations that resolve to the same element share one count; the class is removed only after the last lease is released. The owning-document lease registry deletes its element entry at count zero and is not retained by the workspace coordinator or a detached-save lease. A candidate that progressive enhancement cannot identify safely acquires no lease and leaves the host preview unchanged.

A live presentation whose scroll owner changes because of a workspace layout move performs a two-frame transfer. In the first frame it reads and resolves the candidate before any write, then acquires the new lease in the write phase while retaining the old lease. In the next animation frame it reads the post-style embed and owner geometry, applies the new measurement in the write phase, and only then releases the old lease. A real Widget or `MarkdownRenderChild` unload with no live presentation successor releases its lease immediately; a later remount acquires a fresh lease and never inherits a DOM reference through the coordinator. Target invalidation and plugin unload also release immediately.

The marker MUST NOT use `::-webkit-scrollbar`, `scrollbar-width`, synthetic scrollbars, fixed scrollbar widths, or theme-specific colors. It MUST NOT apply `overflow: hidden`, replace the owner, add a nested vertical scroller, or toggle any overflow or scrollbar property from a pointer handler. Its removal restores the host cascade rather than writing guessed prior values. The horizontally scrollable toolbar remains independent and may hide only its own horizontal scrollbar.

Inkbook measures `containerWidth` from the positive content-box width of its own background container after the lease applies, never from the scroll owner's full `clientWidth`. The embed root uses `box-sizing: border-box` and `max-inline-size: 100%`. A read phase additionally compares the background container's right edge with the scroll owner's client right edge, calculated from the owner border box, `clientLeft`, and `clientWidth`. If nested padding, readable-line width, a list, a callout, or another host layout would place the embed past that edge, the next write phase clamps the root to the non-negative remaining inline size and schedules a new measurement frame before input is enabled. The canvas input surface uses `inset: 0` within the final background container. It never adopts the pane width and cannot cover the native scrollbar gutter.

On desktop systems that expose non-overlay native scrollbars, the right-hand scrollbar track MUST remain present before, during, and after a pen gesture. Operating systems and mobile WebViews may render native scrollbars as auto-hiding overlays even with `overflow-y: scroll`; no public Obsidian or browser contract can force that native overlay thumb to remain painted. CSS reserves `scrollbar-gutter: stable` space for classic scrollbars, while native overlay scrollbars consume no gutter by definition and therefore do not change `clientWidth` when painted or hidden. Inkbook never causes the hide and produces no width or position shift in either mode. Replacing the native control with a custom scrollbar is out of scope.

Pointer capture, the pen scroll guard, note scrolling, anchored zoom, and layout compensation remain main-thread presentation work. No scroll owner, `Document`, `Window`, DOM reference, pointer event, layout measurement, or camera update crosses the document-worker boundary.

## Vault, File, and Link APIs

All paths are untrusted. Inkbook rejects absolute paths and traversal segments before passing a vault-relative path through `normalizePath()`.

Supported operations are:

| Operation                    | Required API and rule                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Resolve a known path         | `Vault.getFileByPath()` or `Vault.getFolderByPath()`, followed by a concrete `TFile` or `TFolder` check             |
| Read for display             | `Vault.cachedRead()`                                                                                                |
| Read for editor unlock       | Size preflight through `TFile.stat.size`, then `Vault.readBinary()` and transferable worker validation              |
| Save an existing SVG         | Size-preflighted, worker-validated `Vault.read()` followed by `Vault.process()` with a synchronous exact-base check |
| Create an SVG                | `Vault.create()` after collision-safe path resolution                                                               |
| Resolve attachment placement | `FileManager.getAvailablePathForAttachment(filename, sourcePath)`                                                   |
| Generate Markdown link text  | `FileManager.generateMarkdownLink(file, sourcePath)`, prefixed with `!` for an embed                                |
| Resolve a link target        | `MetadataCache.getFirstLinkpathDest(linkpath, sourcePath)`                                                          |
| Determine references         | `MetadataCache.resolvedLinks` only after metadata resolution; uncertainty denies deletion                           |
| Rename a managed file        | `FileManager.renameFile()`                                                                                          |
| Delete recoverably           | `FileManager.trashFile()`                                                                                           |

The complete SVG is generated and validated before `Vault.process()` starts. Immediately before every uncached full-file read used for expected-base preflight, mandatory post-write read-back, verification retry, or external-change verification, the bounded persistence port resolves the current `TFile`, records its object identity plus `{ path, ctime, mtime, size }`, and rejects a known size above the 64 MiB file limit. Reads and `Vault.process()` calls for the same normalized path are serialized. After the host read, the port resolves the file again, requires the same identity and metadata, and checks the actual UTF-8 byte length before worker dispatch or adoption. A mismatch, replacement, growth, disappearance, over-limit result, or indeterminate value fails closed and preserves dirty or verification-required state.

Obsidian 1.13 exposes only full-materialization `Vault.read()`, `cachedRead()`, `readBinary()`, and `process()` operations. It has no public range, stream, abort, or `maxBytes` read. The preflight therefore prevents a known oversized file from being read and the postflight prevents raced bytes from being accepted, but external growth between metadata inspection and the host read can still be materialized transiently by Obsidian before Inkbook rejects it. Inkbook MUST NOT bypass this mobile-compatible boundary through `Vault.adapter`, Node, Electron, `FileSystemAdapter`, or undocumented APIs. This residual host-API limitation is recorded rather than hidden behind a false hard-memory claim.

A permitted preflight `Vault.read()` is hashed and revision-checked in the document worker against the last confirmed base. Normal preflight and read-back carry the active save's same `saveOperationId` and target revision and do not advance `exportGeneration`; stale identities are rejected before adoption. If the executor fails after writing begins, read-back instead uses the new executor epoch and a new `verificationOperationId` bound to the immutable old save ID, revision, and output hash. The exact preflight string is retained only until the synchronous `Vault.process()` callback compares the callback's current content with it. This catches an external change in the preflight-to-process race; a mismatch throws a structured conflict and writes nothing. The callback also scans at most 4 KiB for the canonical `data-inkbook-revision` and compares the prepared result revision with the editor's current revision immediately before returning output. It performs no XML or JSON parsing, hashing, serialization, asynchronous work, or allocation proportional to element count. Exact string comparison counts toward the autosave main-thread budget. A successful callback returns the already generated complete SVG and releases the preflight string.

Active Markdown changes, including embed insertion, removal, duplication, and insertion undo, use the current `Editor`. Background Markdown changes use `Vault.process()`. CodeMirror extensions detect targets and manage widgets but do not bypass the `Editor` for document text changes.

Inkbook's Markdown embed discovery accepts at most 8 MiB of actual UTF-8 input and returns at most 4,096 recognized SVG embed matches per document pass. Exceeding either limit yields no Inkbook targets and performs no Markdown or presentation mutation; it does not fall back to an unbounded second parse.

Reference checks MUST NOT scan or parse every Markdown file. Direct path lookup, metadata-cache link resolution, and the existing data-preserving uncertainty rule are mandatory.

## Settings Boundary

Vault settings use `Plugin.loadData()` and `Plugin.saveData()`. Device preferences use `App.loadLocalStorage("inkbook:device-settings:v1")` and `App.saveLocalStorage(...)`; they are local to one device and one vault, not shared across vaults.

Because the minimum app version is 1.13.0, the settings tab MUST implement `PluginSettingTab.getSettingDefinitions()`. Simple values use declarative controls. The existing nested settings object is retained through typed `getControlValue()` and `setControlValue()` overrides rather than flattened duplicate state. `getSettingDefinitions()` performs no file access or expensive computation. UI validation is repeated by the settings loader because declarative `validate` is not a persisted-data invariant.

Settings UI follows these host rules:

- all visible text uses sentence case
- general rows appear first without a `General`, plugin-name, or `Settings` heading
- later distinct sections use concise headings without the word `settings`
- one mutable control appears per row
- controls save on change; multi-field forms use a modal with Save and Cancel
- reset operations use declarative actions or a bounded render callback and refresh affected definitions
- descriptions remain one concise sentence

## Commands, Menus, Icons, and Styling

Commands are registered through `addCommand()` with the narrowest applicable `callback`, `checkCallback`, `editorCallback`, or `editorCheckCallback`. Command IDs omit both the plugin ID and a redundant `command` suffix. Commands define no default hotkeys. Names use sentence case and do not repeat the plugin name.

Canvas and layer actions are exposed through context-aware commands and an Obsidian `Menu`. A mouse `contextmenu` uses `Menu.forEvent()`. Touch and keyboard invocation use `Menu.showAtPosition()` with the owning `Document`. The menu is populated from the spatial-index result returned by the single presentation-owned canvas input surface; content paths have no listeners and are never browser hit-test targets. All menu and invocation details are defined in [Features](features.md#canvas-context-menus).

Every actionable menu entry calls `MenuItem.setIcon()` with the built-in icon specified in [Embed UI](embed-ui.md#context-menu-presentation). The Arrange heading calls `setTitle("Arrange")`, `setIcon("layers")`, and `setIsLabel(true)` with no click handler; its four actions remain flat because no public submenu API exists. Delete, Erase all, and Delete embed additionally call `MenuItem.setWarning(true)`, which gives both title and icon the host warning color. Confirmation is still required for Erase all and Delete embed. Menus close during presentation unload, and focus returns to the invoking control or canvas surface.

Built-in Lucide icons use `setIcon()`. A custom icon is allowed only when no suitable built-in icon exists and is registered through `addIcon()`. Every icon-only control still has an accessible name and tooltip.

Static styling is authored in responsibility-specific files under `src/obsidian/styles/`; `inkbook.css` is the build entry and imports the motion definitions. The build emits one release artifact, `styles.css`. Styling is scoped below one Inkbook root class except for the single lease-owned scroll-element marker defined above, and uses Obsidian variables such as `--background-secondary`, `--background-modifier-border`, `--text-normal`, and `--interactive-accent`. Runtime geometry uses SVG attributes or narrowly scoped CSS custom properties. Untrusted text is assigned with `textContent` or Obsidian DOM helpers. `innerHTML`, `outerHTML`, and `insertAdjacentHTML` are forbidden.

Obsidian variables style host chrome only. The active document graphic and saved standalone SVG use the fixed self-contained palette in [Standalone SVG Envelope and Theme Rendering](svg-envelope.md), because external editors cannot resolve Community-theme variables. The plugin registers `Workspace.on("css-change")`, reads `App.isDarkMode()`, and updates each mounted presentation's root scheme once through that presentation's lifecycle owner. It does not scan files, rebuild paths, increment revisions, dispatch exports, or write the vault. Reading-view and Live Preview embed hosts expose the same scheme to the embedded SVG through `color-scheme`.

## Community Directory Release Contract

Before a Community directory submission, the repository MUST contain root `README.md`, `LICENSE`, and `manifest.json` files. `README.md` and `manifest.json` now exist, but a license has not been selected. The repository therefore remains private, its package is marked `UNLICENSED`, and it is not submission-ready until an appropriate root `LICENSE` file is deliberately added and verified.

The release contract is:

- manifest `id` uses lowercase letters and hyphens, contains no `obsidian`, and does not end in `plugin`
- manifest `version` and the GitHub release tag are identical `x.y.z` semantic versions
- `minAppVersion` is the actual tested minimum and `isDesktopOnly` remains `false`
- the description is at most 250 characters, ends with a period, contains no emoji, and follows Obsidian capitalization
- `fundingUrl` exists only when it links to financial support
- source contains no sample names, placeholder code, obfuscation, telemetry, self-update logic, dynamic ads, or unnecessary console logging
- the release attaches `main.js`, `manifest.json`, and optional `styles.css`; the production `main.js` is minified and is not committed as source
- `versions.json` records compatibility when release history requires it
- third-party licenses and required attribution are recorded in `LICENSE` or `README.md`
- network use, external vault access, accounts, payments, and other policy-sensitive behavior are disclosed; Inkbook's first release declares none of them

CI uses the official `eslint-plugin-obsidianmd` recommended type-aware configuration and treats applicable findings as errors. Submission readiness is verified from source plus built artifacts; documentation alone cannot establish compliance.

## Official References

This contract was checked on 2026-08-21 against:

- [Plugin guidelines](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Releasing/Plugin%20guidelines.md)
- [Developer policies](https://docs.obsidian.md/community-directory/developer-policies)
- [Submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)
- [Submit your plugin](https://docs.obsidian.md/plugins/releasing/submit-plugin)
- [Manifest reference](https://docs.obsidian.md/Reference/Manifest)
- [Editor extensions](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Editor/Editor%20extensions.md)
- [Decorations and syntax-tree access](https://docs.obsidian.md/Plugins/Editor/Decorations)
- [Official sample-plugin build externals](https://github.com/obsidianmd/obsidian-sample-plugin/blob/master/esbuild.config.mjs)
- [Markdown post processing](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Editor/Markdown%20post%20processing.md)
- [Vault guide](https://docs.obsidian.md/Plugins/Vault)
- [Lifecycle management](https://docs.obsidian.md/plugins/guides/lifecycle-management)
- [Declarative settings](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/User%20interface/Settings.md)
- [Official API definitions](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- [Color variables](https://docs.obsidian.md/Reference/CSS%20variables/Foundations/Colors)
- [Official ESLint plugin](https://github.com/obsidianmd/eslint-plugin)
- [Compression Streams API](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream)
- [Dynamic import](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import)

## Related Documentation

- [Implementation specification](specification.md)
- [Features](features.md)
- [Settings](settings.md)
- [Embed UI](embed-ui.md)
- [Quality and testing](quality-and-testing.md)
