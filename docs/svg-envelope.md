# Standalone SVG Envelope and Theme Rendering

## Authority and Fidelity Scope

The saved file is a complete, standalone SVG image as well as an Inkbook document. A supported external SVG viewer or editor MUST reproduce the same canonical locked document view as the plugin for the same light or dark color scheme: page surface, background guides, element geometry, paint, opacity, and back-to-front order inside the saved `viewBox`.

Plugin chrome is outside this fidelity contract. The floating toolbar, menus, selection handles, cursors, dynamic rounded container, clipping radius, and other interactive overlays are host UI and are not serialized. Unlock animates the lifecycle-owned block from the serialized `lockedHeight` to derived `activeHeight`; workspace beyond `lockedHeight` is transient and is not part of the canonical locked view. The SVG page itself remains rectangular. Its unpatterned margin is serialized on all four sides, scales with the page, and remains writable; background guides stop at the margin's inner edge.

The editable snapshot remains the source of truth. Static SVG drawing elements and the embedded theme stylesheet are deterministic derived output.

## Required Envelope

An Inkbook file is UTF-8 XML with this required order:

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="0 0 2048.6 {lockedHeight}"
     data-inkbook-format="inkbook"
     data-inkbook-version="1"
     data-inkbook-revision="{revision}"
     data-inkbook-snapshot-sha256="{lowercase SHA-256 of decoded compact JSON}">
  <style id="inkbook-theme">{canonical theme stylesheet}</style>
  <metadata id="inkbook-snapshot" data-encoding="json">{escaped compact JSON}</metadata>
  <g id="inkbook-background" />
  <g id="inkbook-highlights" />
  <g id="inkbook-content" />
</svg>
```

The background group starts with one page-surface path covering the complete `viewBox`, including the writable margin. Background guides follow it. The page path has no rounded corners; the plugin's dynamic host container performs rounded clipping. The canonical root stylesheet sets `overflow: hidden` on the standalone SVG, so geometry outside the rectangular `viewBox` remains editable in metadata but is not painted by external viewers.

Additional envelope rules:

- Metadata is the exact canonical compact JSON serialization escaped as XML text. Loading streams its XML character data through the bounded `StreamingSvgMetadataParser`, decodes only the permitted XML entities, and parses the decoded text with the synchronous bounded structural-scan plus native parser or the bounded chunked parser, without creating an SVG DOM. Current-version loading rejects whitespace, noncanonical property order, duplicate keys, or any other decoded text that differs from canonical reserialization of the validated snapshot.
- `data-inkbook-snapshot-sha256` is the lowercase SHA-256 of the decoded canonical metadata text. Current-version loading requires an exact hash match in both synchronous and streaming paths. This consistency binding detects uncoordinated metadata rewriting, including changes to fields that do not affect locked static geometry; it does not establish origin or authenticity.
- `viewBox` is authoritative; `width` and `height` MAY be omitted.
- Opacity output uses at most four decimal places so every canonical snapshot opacity remains exact. All other numeric SVG output uses at most three decimal places. Numeric output removes insignificant trailing zeros.
- `data-inkbook-revision` is the canonical unsigned decimal snapshot revision. A root and snapshot mismatch is invalid.
- Scripts, event-handler attributes, `foreignObject`, animation elements, external URLs, external stylesheets, remote fonts, and non-vault resources are forbidden.
- Static output MUST remain viewable without Inkbook and MUST NOT depend on Obsidian CSS variables.

## Portable Light and Dark Palette

Format version 1 uses this fixed document palette, derived from Obsidian's default base color roles but serialized explicitly so external software has no Obsidian dependency:

| Role             | Light       | Dark        |
| ---------------- | ----------- | ----------- |
| Page surface     | `#F6F6F6FF` | `#212121FF` |
| Theme text       | `#222222FF` | `#DADADAFF` |
| Background guide | `#ABABAB40` | `#66666640` |

`ColorV1` values with `type: "theme-text"` use the Theme text role. Explicit RGBA colors, including built-in highlighter and palette colors, retain the same value in both schemes.

The serializer emits one constant-size stylesheet equivalent to:

<!-- prettier-ignore -->
```css
:root {
  color-scheme: light dark;
  --inkbook-page: #F6F6F6FF;
  --inkbook-text: #222222FF;
  --inkbook-guide: #ABABAB40;
}
@media (prefers-color-scheme: dark) {
  :root {
    --inkbook-page: #212121FF;
    --inkbook-text: #DADADAFF;
    --inkbook-guide: #66666640;
  }
}
@media print {
  :root {
    --inkbook-page: #F6F6F6FF;
    --inkbook-text: #222222FF;
    --inkbook-guide: #ABABAB40;
  }
}
svg { overflow: hidden; }
.inkbook-theme-page { fill: var(--inkbook-page); }
.inkbook-theme-guide { stroke: var(--inkbook-guide); vector-effect: non-scaling-stroke; }
.inkbook-theme-stroke { stroke: var(--inkbook-text); }
.inkbook-theme-fill { fill: var(--inkbook-text); }
.inkbook-theme-stroke-fill { stroke: var(--inkbook-text); fill: var(--inkbook-text); }
```

Theme-dependent paths also carry the corresponding direct light RGBA presentation attribute. That attribute is the deterministic fallback when an external editor does not apply internal CSS or media queries. Theme-dependent geometry is never duplicated into separate light and dark groups.

The plugin's active SVG scene uses the same palette values. Obsidian variables style only host chrome, menus, focus treatment, the border, and the rounded container. Community themes may change that host chrome, but they do not change the portable document palette. This separation is required for external fidelity without theme-driven file rewrites.

Readers also accept the previous exact version 1 stylesheets whose guide colors were `#DCDCDCFF` and `#383838FF`, and the earlier translucent variants `#70707040` and `#99999940`, including the earlier dark page surfaces `#282828FF` and `#212121FF`, plus the immediately preceding canonical stylesheets without scale-independent guide strokes or explicit root overflow clipping. These compatibility inputs are not emitted. Loading marks any supported non-current stylesheet for a canonical rewrite, so locking after unlock performs a verified save even without a content edit and refreshes the preview only after readback succeeds. Unlocking reconstructs the active scene from the semantic snapshot with the current low-contrast guide palette. Guide colors use 25-percent alpha, matching the restrained host-grid contrast while remaining self-contained. Normal SVG antialiasing replaces `crispEdges`, which avoids neighboring guides being rounded to visibly different physical widths at fractional zoom or display scale. `vector-effect: non-scaling-stroke` retains a uniform one-screen-pixel guide weight in a correctly sized SVG viewport. Theme-guide paths keep their version-1 direct fallback stroke for static-group compatibility, while their required class resolves to the current palette in every canonical renderer.

Readers additionally accept three exact version 1 background fragments: the immediately preceding inset geometry, the earlier top-anchored geometry that omitted the square top boundary and did not inset dots horizontally, and the older geometry whose vertical guides were centered within the writable height. Compatibility requires the complete background fragment to equal deterministic output derived from the validated snapshot and supported locked height. It never relaxes element, envelope, limit, metadata, or hash validation. Every historical input is marked for a verified canonical rewrite.

One canonical inner page frame runs exactly between the fixed page margins and never depends on background type or spacing. Lines, Dots, and Squares share the absolute 25, 100 / 3, 50, and 100 page-unit series without type-specific multipliers or page-buffer scaling. Squares include the frame's top, bottom, left, and right boundaries. Dots occupy the exact intersections of the corresponding square grid. Lines retain only horizontal guides. Internal guides retain the requested spacing from the top-left origin; if a dimension is not divisible, a shorter final interval closes exactly at the immutable right or bottom edge. Standalone serialization and the active pattern plus terminal renderer consume the same domain layout, and current writers emit only this geometry. Page height derives from fixed 100-unit layout rows, so changing the background never changes the SVG envelope.

## Strict Static-Markup Allowlist

Generated static markup uses only `svg`, `style`, `metadata`, `g`, and `path`. The safe-preview validator accepts:

- the documented root attributes, including a lowercase 64-character SHA-256 token for current-version metadata; editable loading subsequently verifies that token against the canonical decoded metadata
- `id` and `data-encoding` only where shown
- `d`, `fill`, `fill-opacity`, `fill-rule`, `stroke`, `stroke-width`, `stroke-opacity`, `stroke-linecap`, `stroke-linejoin`, `stroke-dasharray`, and one allowlisted `class` on paths
- exact `#RRGGBBAA`, `none`, or the canonical theme-class override for paint

The only classes are `inkbook-theme-page`, `inkbook-theme-guide`, `inkbook-theme-stroke`, `inkbook-theme-fill`, and `inkbook-theme-stroke-fill`. A path has at most one theme class; the combined class avoids duplicating closed-shape geometry when both outline and fill use Theme text. The only accepted style element has `id="inkbook-theme"` in the required position and text exactly equal to either the serializer's canonical minified stylesheet or the explicitly allowlisted previous version 1 stylesheet. The validator rejects additional CSS, selectors, declarations, custom properties, `url()`, `@import`, unknown classes, transforms, namespace extensions, and every unlisted element or attribute. Export bakes element rotation into path coordinates.

Safe-preview attribute values are validated before any replacement SVG DOM is created:

- Paint is `none`, exact `#RRGGBBAA`, or the effect of the one allowlisted theme class.
- Opacity is a finite canonical decimal from 0 through 1 with at most four fractional digits. Stroke width and every dash value are finite canonical decimals from 0 through 256 with at most three fractional digits; a dash array has at most eight values and cannot be all zero.
- Fill rule is exactly `nonzero` or `evenodd`, line cap is `butt`, `round`, or `square`, and line join is `miter`, `round`, or `bevel`. Absent optional attributes use SVG defaults and no other token is accepted.
- Path data uses only uppercase `M`, `L`, `Q`, `C`, `A`, and `Z`, ASCII separators and signs, and finite non-exponent decimal numbers with at most three fractional digits. Command arity and subpath closure are validated. Arc radii are greater than zero and at most 1,000,000 page units, arc rotation is exactly zero, and large-arc and sweep flags are each exactly `0` or `1`. Every endpoint, coordinate, and control point is within the absolute 1,000,000-page-unit limit, and no trailing token is accepted.
- One path contains at most 1 MiB of `d` text and 20,000 commands. One file contains at most 60,004 paths, 48 MiB of combined `d` text, and 8,000,000 path commands, in addition to the lower total-file, snapshot, element, and point limits in [File Format](file-format.md#limits).

The streaming validator counts UTF-8 bytes, paths, commands, and numeric tokens without constructing SVG nodes or browser path objects. Crossing any limit, malformed or non-finite input, or a value outside its range makes the replacement preview ineligible and leaves the file noninteractive. Canonical files produced from a validated snapshot MUST satisfy both snapshot and static-markup limits.

## Theme Changes in Obsidian

The plugin registers the public workspace `css-change` event and reads the current scheme through `App.isDarkMode()`. Each mounted presentation remembers its applied scheme. A changed scheme performs exactly one presentation-root palette or `color-scheme` update and queues one paint invalidation through the existing animation-frame coalescer.

A scheme change performs no path construction, geometry calculation, bounds or anchor invalidation, spatial-index update, React ink render, document revision, history entry, dirty transition, worker export, or vault write. Every mounted main-window and pop-out presentation updates through its own lifecycle owner. Unmounted files are not scanned or opened.

Lifecycle-owned Reading-view and Live Preview hosts set their embedding root `color-scheme` to the result of `App.isDarkMode()`. The locked preview removes the validated file stylesheet and applies equivalent canonical paint through rules scoped to that owned root; the standalone file continues to evaluate `prefers-color-scheme` itself. A real scheme transition remounts the already validated inert presentation markup with the new scoped scheme without file I/O, serialization, or cache-busting. If Reading-view enhancement cannot identify and validate the exact custom Inkbook block, it leaves the non-image Markdown link unchanged and disables Inkbook interaction. Inkbook MUST NOT compensate with private DOM selectors.

The plugin-owned locked surface uses neither an HTML image nor an object or iframe browsing context. A `css-change` whose `App.isDarkMode()` result differs from the presentation's remembered scheme remounts only its already validated presentation tree after updating the root scheme. Repeated CSS changes within the same scheme do nothing. This repaint performs no vault read or write, SVG serialization, worker dispatch, revision change, cache-busting query, unlock, or document-wide DOM search. It never scans unmounted notes or files, and it does not alter an unrecognized custom link. Active editor scenes still use the root-palette update.

## External Compatibility and Verification

- Browsers and SVG software that support internal styles plus `prefers-color-scheme` switch automatically.
- Software without media-query support renders the complete deterministic light fallback rather than missing or recolored geometry.
- Printing uses the explicit light palette.
- External fidelity compares document graphics only, not plugin chrome or rounded clipping.
- The stylesheet and class tokens count toward the complete-SVG byte budget.
- Fidelity covers opening and rendering the canonical file. An external editor that rewrites the stylesheet, class names, path structure, envelope, or metadata produces a noncanonical document that Inkbook must reject for editing rather than silently reinterpret; external-editor round-trip authoring is outside version 1.

Release verification compares the same fixture in the active scene and saved SVG in light and dark mode, including fixed colors, Theme text, transparency, highlighters, every background, shapes, arrow nodes, and overlapping render bands. The matrix covers Reading view, Live Preview, main and pop-out windows, current Chromium-, Firefox-, and Safari-based SVG viewers, and at least one external vector editor. Raster comparisons use one documented anti-aliasing tolerance; geometry, order, and canonical colors require exact agreement. The fallback light rendering is checked with media-query application disabled.

For every supported Obsidian version and platform, the release matrix verifies that the custom Inkbook block becomes the same plugin-owned preview in Reading view and Live Preview. An unrecognized or invalid block remains a non-image link and never claims theme parity or interactive behavior.

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
