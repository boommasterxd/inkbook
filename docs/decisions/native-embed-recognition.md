# Native Embed Recognition

## Decision

Persist native Wiki-image or Markdown-image references so saved SVG drawings remain
visible in Obsidian without Inkbook. Enhance eligible standalone occurrences through
the existing public Markdown and CodeMirror lifecycle boundaries after strict Inkbook
recognition. Do not add an adjacent comment or rewrite notes on plugin activation,
deactivation, or uninstall.

Automatic recognition applies to eligible references to the document, including
manually inserted references. The canonical eligibility and fallback rules are in
[Obsidian Integration](../obsidian-integration.md#native-embeds).
Native image syntax is the only supported embed format. The private pre-release
vaults were converted once with backed-up note edits before removing the custom
syntax parser, migration command, generation fallback, and export branch.

## Reasons and Boundaries

- The native reference is sufficient for the host image renderer; no duplicate
  fallback image or plugin stylesheet is required.
- The existing resolver and bounded recognition owner preserve file identity,
  validation reuse, revision/hash correlation, and scheduler admission.
- Reading occurrences share a bounded current-source parser and line index, while
  document-scoped recognition subscriptions avoid unrelated per-occurrence work.
  Live Preview uses CodeMirror range queries for visible candidates. Cache bounds,
  source freshness, and ownership remain canonical in [Obsidian Integration](../obsidian-integration.md#native-embeds).
- An occurrence comment would add a second source identity to copying, deletion,
  and rendering without replacing document validation.
- Positive integer widths reuse the existing width-fit presentation and resize
  pipeline. Unsupported dimensions, fragments, mixed sections, and ordinary images retain host
  behavior. Inkbook does not search private image DOM to claim an occurrence.
- Reference safety considers all links, independently of presentation eligibility.
- Copied references retain the resolved Vault target rather than a source-relative
  or shortest link. The behavior is canonical in [Features](../features.md#copying-the-entire-embed).
- The plugin neither migrates notes nor scans the vault on activation. The one-time
  external conversion preserved SVG bytes and reference targets. SVG document
  version migration remains a separate persistence responsibility.

## Verification Boundary

The initial feasibility check used the installed Flatpak Obsidian 1.15.0 in an
isolated X11 session and the dedicated QA vault. Public postprocessor section ranges,
whole-section replacement with lifecycle restoration, and CodeMirror block
replacement alongside native image decorations were exercised before implementation.
This does not establish physical mobile behavior or other plugins' compatibility.
Native references use the sectionless export path after safe source and
semantic-image correlation, including export finalization and pagination. Its
host timing and width rules are canonical in [Native PDF Export Pagination](../export-pagination.md).
The normal scoped verification and manual release requirements remain applicable.
