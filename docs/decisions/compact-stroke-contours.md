# Compact Stroke Contours

Status: Accepted

## Context

The reference fixture contains 74 strokes, including 44 pressure strokes with 10,588 samples. Adjacent capsule pieces use different chord normals and rarely meet the exact cross-section equality required for packing. One SVG path per element therefore does not bound its internal drawing complexity.

The original reference acceptance target was at most 130 pressure subpaths and 41,177 pressure path bytes. The accepted finer pressure-contour target raises the byte ceiling to 57,325 while retaining the 130-subpath limit, geometric correctness and responsive interaction. These are document-specific output budgets, not a universal limit or a latency measurement.

## Decision

Implement Inkbook-owned compact contour construction from mathematical requirements. Construct fill contours of bounded windows of prepared circular-nib capsules, then simplify and quantize them within an explicit error budget. Regular connected chains use linear tangent joins; ambiguous joins retain exact union preparation. Independent closed windows preserve continuous fill. The linear contour can retain internal edges or encode a hole through winding rather than separate Boolean boundary loops. Preserve editable samples, pressure-dependent width, endpoints, opacity, and shared live/export/selection semantics. Constant-width pen and highlighter strokes remain ordinary round-capped SVG strokes and benefit from derived centerline simplification.

Keep only current stroke and shape contour generation and verification. Inkbook is still pre-production, and the working reference drawing has been saved with current geometry. Maintaining earlier geometry profiles would retain duplicate serializers and unlock work without a supported deployed-document requirement. This original decision rejected earlier geometry without migration. Snapshot-authoritative loading later superseded that rejection: safe static contours can differ from current output, while export verification still checks current canonical geometry. Exact stylesheet compatibility, supported snapshot-version migration, and accepted schema widths remain unchanged.

The canonical algorithm, streaming ownership and work bounds belong in [Rendering and Performance](../rendering-and-performance.md). Snapshot-authoritative input acceptance, canonical output verification, and retained envelope compatibility belong in [SVG Envelope](../svg-envelope.md). Selection preparation and essential-feedback behavior belong in [Editor Tools](../editor-tools.md).

Broad pressure strokes retain finer center and radius detail rather than long straight transitions between pressure regions. The explicit 57,325-byte budget accepts this detail while retaining the 130-subpath limit; it is not a complete-file size limit or a speed guarantee. Raw samples, the nib diameter formula, position smoothing, constant-width strokes and the sample codec remain unchanged. The tighter combined error bound also limits derived pressure averaging, as defined in the canonical algorithm.

## Verification Boundaries

The reference contains no highlighter, so shared constant-width construction requires separate highlighter coverage. Output complexity does not establish frame latency.

Acceptance requires output-complexity checks, pressure and constant-width geometry regressions, bounded live and selection work, rejection of noncanonical persisted output during canonical verification, the complete project gate, and real-Obsidian interaction checks. Browser paint/filter costs and physical-device responsiveness are separate from deterministic CI work counters. Final verification results must distinguish passed checks from unavailable hardware evidence.

Native-host acceptance covers zoom, enclosing and cutting lasso, consecutive moves, resize, deselection, save and reopen across desktop, tablet and phone. Constant-pressure, varying-pressure, pressure-disabled pen and highlighter strokes require active/export path parity. Physical pen, Android input-stack and GPU-device latency remain unverified; virtual-display checks cannot establish them.

[Snapshot-authoritative unlock](validated-unlock-geometry-reuse.md) supersedes the earlier validated-pressure-path transfer and cross-session reuse. Modifier pixel-wheel zoom uses continuous scaling across event magnitudes and reuses projected cursor layout after zoom writes. Their canonical contracts are in [Rendering and Performance](../rendering-and-performance.md) and [Zoom](../zoom.md). Selection effects still add raster work; physical touchpad responsiveness remains unverified and requires separate hardware acceptance.

## Linear Chain Follow-up

Regular capsule chains bypass Boolean clipping and stitching through direct tangent joins; conservative boundary rectangles prune disjoint comparisons in the exact fallback. These work reductions do not establish elapsed-time guarantees.

Adjacent capsules reuse prepared center nibs, and each exact-union window lazily reuses original arc start angles. That window-local angle cache also serves arc midpoint classification and clipped-arc endpoints. Exact-union source and query boundaries use conservative, tight bounds: directed arcs include stored endpoints and cardinal extrema, while unresolved sweep, radius, or endpoint geometry falls back to the full carrier. Line bounds include roundoff padding. Keep fixed line direction and carrier arithmetic direct instead of retaining additional line-metadata caches. Point-dependent roundoff checks and analytic intersection order remain unchanged. No reverse-direction intersection cache is used because reversing the calculation risks changing floating-point rounding. This window-local angle cache preserves emitted geometry and does not introduce cross-session geometry proofs or accept supplied static paths as canonical. Verify affected radius, angle and geometry work, including empty ranges and early cancellation. Profile actual cold-open and export latency separately.

The existing allowance counts actual geometric probes: tighter conservative rejection can let a window complete instead of reaching the complete-capsule fallback, while preserving fill. Both outcomes retain the canonical capacity and scheduler-checkpoint contracts in [Rendering and Performance](../rendering-and-performance.md). Observe the affected intersection and boundary-classification work, verify cancellation and fallback, and compare contour coordinates against full-carrier rejection.

## Bounded Preparation Follow-up

Keep exact native distance and angle predicates while reusing unchanged boundary scalars within one union window. Quantization prepares fixed edge products before examining candidates. Collinear pruning retains the legacy earliest-removal order with original-index neighbor links and a bounded priority queue, rather than rescanning unchanged prefixes after each removal. This preserves emitted coordinates, expansion triangles, and fallback decisions. Ownership, capacities, and scratch limits remain in [Rendering and Performance](../rendering-and-performance.md#live-stroke-and-saved-stroke); actual arithmetic, heap, buffer, and cancellation coverage belongs in [Performance CI](../performance-ci.md#coverage-and-remaining-gaps).
