# Standalone SVG Envelope and Theme Rendering

## Authority and Fidelity Scope

The saved file is a complete, standalone SVG image as well as an Inkbook document. A supported external SVG viewer or editor MUST reproduce the same canonical locked document view as the plugin for the same light or dark color scheme: page surface, background guides, element geometry, paint, opacity, and back-to-front order inside the saved `viewBox`.

Plugin chrome is outside this fidelity contract. The floating toolbar, menus, selection handles, cursors, dynamic rounded container, clipping radius, and other interactive overlays are host UI and are not serialized. The active editor's additional writable bottom buffer beyond `lockedHeight` is transient workspace, not part of the canonical locked view. The SVG page itself remains rectangular, including its writable side margin.

The editable snapshot remains the source of truth. Static SVG drawing elements and the embedded theme stylesheet are deterministic derived output.

## Required Envelope

An Inkbook file is UTF-8 XML with this required order:

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="0 0 2048.6 {lockedHeight}"
     data-inkbook-format="inkbook"
     data-inkbook-version="1"
     data-inkbook-revision="{revision}">
  <style id="inkbook-theme">{canonical theme stylesheet}</style>
  <metadata id="inkbook-snapshot" data-encoding="json">{escaped compact JSON}</metadata>
  <g id="inkbook-background" />
  <g id="inkbook-highlights" />
  <g id="inkbook-content" />
</svg>
```

The background group starts with one page-surface path covering the complete `viewBox`, including the writable margin. Background guides follow it. The page path has no rounded corners; the plugin's dynamic host container performs clipping.

Additional envelope rules:

- Metadata is compact JSON escaped as XML text. Loading reads `textContent` before JSON parsing.
- `viewBox` is authoritative; `width` and `height` MAY be omitted.
- Numeric SVG output uses at most three decimal places and removes insignificant trailing zeros.
- `data-inkbook-revision` is the canonical unsigned decimal snapshot revision. A root and snapshot mismatch is invalid.
- Scripts, event-handler attributes, `foreignObject`, animation elements, external URLs, external stylesheets, remote fonts, and non-vault resources are forbidden.
- Static output MUST remain viewable without Inkbook and MUST NOT depend on Obsidian CSS variables.

## Portable Light and Dark Palette

Format version 1 uses this fixed document palette, derived from Obsidian's default base color roles but serialized explicitly so external software has no Obsidian dependency:

| Role | Light | Dark |
|---|---|---|
| Page surface | `#F6F6F6FF` | `#282828FF` |
| Theme text | `#222222FF` | `#DADADAFF` |
| Background guide | `#70707040` | `#99999940` |

`ColorV1` values with `type: "theme-text"` use the Theme text role. Explicit RGBA colors, including built-in highlighter and palette colors, retain the same value in both schemes.

The serializer emits one constant-size stylesheet equivalent to:

```css
:root {
  color-scheme: light dark;
  --inkbook-page: #F6F6F6FF;
  --inkbook-text: #222222FF;
  --inkbook-guide: #70707040;
}
@media (prefers-color-scheme: dark) {
  :root {
    --inkbook-page: #282828FF;
    --inkbook-text: #DADADAFF;
    --inkbook-guide: #99999940;
  }
}
@media print {
  :root {
    --inkbook-page: #F6F6F6FF;
    --inkbook-text: #222222FF;
    --inkbook-guide: #70707040;
  }
}
.inkbook-theme-page { fill: var(--inkbook-page); }
.inkbook-theme-guide { stroke: var(--inkbook-guide); }
.inkbook-theme-stroke { stroke: var(--inkbook-text); }
.inkbook-theme-fill { fill: var(--inkbook-text); }
.inkbook-theme-stroke-fill { stroke: var(--inkbook-text); fill: var(--inkbook-text); }
```

Theme-dependent paths also carry the corresponding direct light RGBA presentation attribute. That attribute is the deterministic fallback when an external editor does not apply internal CSS or media queries. Theme-dependent geometry is never duplicated into separate light and dark groups.

The plugin's active SVG scene uses the same palette values. Obsidian variables style only host chrome, menus, focus treatment, the border, and the rounded container. Community themes may change that host chrome, but they do not change the portable document palette. This separation is required for external fidelity without theme-driven file rewrites.

## Strict Static-Markup Allowlist

Generated static markup uses only `svg`, `style`, `metadata`, `g`, and `path`. The safe-preview validator accepts:

- the documented root attributes
- `id` and `data-encoding` only where shown
- `d`, `fill`, `fill-opacity`, `fill-rule`, `stroke`, `stroke-width`, `stroke-opacity`, `stroke-linecap`, `stroke-linejoin`, `stroke-dasharray`, and one allowlisted `class` on paths
- exact `#RRGGBBAA`, `none`, or the canonical theme-class override for paint

The only classes are `inkbook-theme-page`, `inkbook-theme-guide`, `inkbook-theme-stroke`, `inkbook-theme-fill`, and `inkbook-theme-stroke-fill`. A path has at most one theme class; the combined class avoids duplicating closed-shape geometry when both outline and fill use Theme text. The only accepted style element has `id="inkbook-theme"` in the required position and text exactly equal to the serializer's canonical minified stylesheet. The validator rejects additional CSS, selectors, declarations, custom properties, `url()`, `@import`, unknown classes, transforms, namespace extensions, and every unlisted element or attribute. Export bakes element rotation into path coordinates.

Safe-preview attribute values are validated before any replacement SVG DOM is created:

- Paint is `none`, exact `#RRGGBBAA`, or the effect of the one allowlisted theme class.
- Opacity is a finite canonical decimal from 0 through 1. Stroke width and every dash value are finite canonical decimals from 0 through 256; a dash array has at most eight values and cannot be all zero.
- Fill rule is exactly `nonzero` or `evenodd`, line cap is `butt`, `round`, or `square`, and line join is `miter`, `round`, or `bevel`. Absent optional attributes use SVG defaults and no other token is accepted.
- Path data uses only uppercase `M`, `L`, `Q`, `C`, `A`, and `Z`, ASCII separators and signs, and finite non-exponent decimal numbers with at most three fractional digits. Command arity and subpath closure are validated. Arc radii are greater than zero and at most 1,000,000 page units, arc rotation is exactly zero, and large-arc and sweep flags are each exactly `0` or `1`. Every endpoint, coordinate, and control point is within the absolute 1,000,000-page-unit limit, and no trailing token is accepted.
- One path contains at most 1 MiB of `d` text and 20,000 commands. One file contains at most 60,004 paths, 48 MiB of combined `d` text, and 8,000,000 path commands, in addition to the lower total-file, snapshot, element, and point limits in [File Format](file-format.md#limits).

The streaming validator counts UTF-8 bytes, paths, commands, and numeric tokens without constructing SVG nodes or browser path objects. Crossing any limit, malformed or non-finite input, or a value outside its range makes the replacement preview ineligible and leaves the file noninteractive. Canonical files produced from a validated snapshot MUST satisfy both snapshot and static-markup limits.

## Theme Changes in Obsidian

The plugin registers the public workspace `css-change` event and reads the current scheme through `App.isDarkMode()`. Each mounted presentation remembers its applied scheme. A changed scheme performs exactly one presentation-root palette or `color-scheme` update and queues one paint invalidation through the existing animation-frame coalescer.

A scheme change performs no path construction, geometry calculation, bounds or anchor invalidation, spatial-index update, React ink render, document revision, history entry, dirty transition, worker export, or vault write. Every mounted main-window and pop-out presentation updates through its own lifecycle owner. Unmounted files are not scanned or opened.

Lifecycle-owned Reading-view and Live Preview image hosts set their embedding node's `color-scheme` to the result of `App.isDarkMode()`. Secure embedded SVG images evaluate `prefers-color-scheme` from that embedding context. If progressive Reading-view enhancement cannot identify the host node, Inkbook leaves the native preview unchanged and disables Inkbook interaction. That host-owned fallback may follow the operating-system scheme rather than Obsidian's scheme because Obsidian exposes no public native-embed handle; Inkbook MUST NOT compensate with private DOM selectors.

At startup, each owning `Window` performs one constant-size capability check against an in-memory canonical SVG to verify that changing the embedding `color-scheme` repaints an SVG image. If a supported host version fails that check, a `css-change` whose `App.isDarkMode()` result differs from the presentation's remembered scheme replaces only each currently mounted, lifecycle-owned locked-preview image node in that window once with an equivalent node using the same vault URL and file bytes. Repeated CSS changes within the same scheme do nothing. This compatibility fallback performs no vault read or write, SVG serialization, worker dispatch, revision change, cache-busting query, or unlock. It never scans unmounted notes or files, and it does not alter a host preview that progressive enhancement could not safely identify. Active editor scenes still use the root-palette update.

## External Compatibility and Verification

- Browsers and SVG software that support internal styles plus `prefers-color-scheme` switch automatically.
- Software without media-query support renders the complete deterministic light fallback rather than missing or recolored geometry.
- Printing uses the explicit light palette.
- External fidelity compares document graphics only, not plugin chrome or rounded clipping.
- The stylesheet and class tokens count toward the complete-SVG byte budget.
- Fidelity covers opening and rendering the canonical file. An external editor that rewrites the stylesheet, class names, path structure, envelope, or metadata produces a noncanonical document that Inkbook must reject for editing rather than silently reinterpret; external-editor round-trip authoring is outside version 1.

Release verification compares the same fixture in the active scene and saved SVG in light and dark mode, including fixed colors, Theme text, transparency, highlighters, every background, shapes, arrow nodes, and overlapping render bands. The matrix covers Reading view, Live Preview, main and pop-out windows, current Chromium-, Firefox-, and Safari-based SVG viewers, and at least one external vector editor. Raster comparisons use one documented anti-aliasing tolerance; geometry, order, and canonical colors require exact agreement. The fallback light rendering is checked with media-query application disabled.

For every supported Obsidian version and platform, the release matrix separately verifies that an unidentified host-owned native Reading-view preview inherits the correct scheme. A failure blocks claiming theme parity for that host version, but does not permit private DOM integration. Runtime encounters with an unfamiliar host preview retain the safe noninteractive fallback and expose this documented theme limitation.

## Standards References

- [Media Queries Level 5: preferred color scheme in embedded SVG](https://www.w3.org/TR/mediaqueries-5/#prefers-color-scheme)
- [Obsidian color variables](https://docs.obsidian.md/Reference/CSS%20variables/Foundations/Colors)
- [Obsidian API definitions](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)

## Related Documentation

- [Core model](core-model.md)
- [File format and geometry](file-format.md)
- [Embed UI](embed-ui.md)
- [Rendering and performance](rendering-and-performance.md)
- [Obsidian integration](obsidian-integration.md)
- [Quality and testing](quality-and-testing.md)
