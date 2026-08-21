# Inkbook Obsidian Plugin Specification

Status: Implementation baseline; Phase 0 feasibility gates remain mandatory

This directory defines Inkbook as a desktop- and Android-capable Obsidian plugin and is the only normative product specification. The former standalone application specification and mockup have been removed.

Inkbook adds a retained SVG annotation layer to ordinary Obsidian Markdown notes. Markdown remains native Obsidian content. Inkbook-owned strokes, highlighters, shapes, lines, arrows, endpoint attachments, tables, coordinate systems, styles, bindings, anchors, and z-order are stored in one Vault-local sidecar file per annotated note. Sidecars are adjacent by default or stored below one configured Vault-relative root.

## Normative Language

The words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative. An implementation is conforming only when every applicable MUST is implemented and verified.

Verification is automation-first. Every behavior, invariant, boundary, failure path, race, lifecycle rule, and performance property that can be driven or observed through code MUST have executable coverage at the lowest faithful test layer. A written manual procedure MUST NOT replace an automatable test. Each implementation phase ends with one concise human sanity check of only the newly visible workflow; it supplements the automated evidence and never carries compatibility-matrix, performance, coverage, resource-accounting, or fault-injection proof.

## Product Boundary

The plugin MUST:

- run inside Obsidian on supported desktop and Android tablet or phone installations;
- preserve native Markdown editing and Obsidian rendering;
- let users draw and place plugin-owned vector elements throughout a note;
- infer whether completed annotations follow a text range, one text position, or a fixed note position and reproject text-bound elements as Markdown wraps;
- zoom the note content and annotation overlay together;
- provide the toolbar and contextual stylebar specified in this directory;
- persist annotation data in a versioned sidecar at its validated Vault-relative location;
- use minimal YAML properties only as an annotation-presence hint and untrusted sidecar locator;
- retain the high-performance SVG rendering model;
- preserve stored line widths when shapes, Tables, coordinate-system axes, Groups, or multi-selections change geometry;
- remain fully interactive at the 5,000-element minimum tier and pass the 10,000-element release stress tier through viewport-bounded retained SVG, minimal coarse-UI framework commits, and worker-first pure computation.

The initial manifest baseline is `minAppVersion: 1.8.7` and `isDesktopOnly: false`. Raising the minimum version requires an explicit compatibility decision and updated desktop and Android acceptance evidence.

The plugin MUST NOT implement a separate document format, page manager, finite paper sizes, Markdown text boxes, image insertion, PDF embeds, web embeds, global search, current-note search, custom YAML rendering, custom KaTeX rendering, or custom Mermaid rendering. Those concerns remain with Obsidian or are outside the new product.

## Specification Index

| Document                                                                                               | Purpose                                                                                                            |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| [Product Scope](01-product-scope.md)                                                                   | Defines user-visible capabilities, exclusions, modes, and acceptance boundaries.                                   |
| [Interaction and Tools](02-interaction-and-tools.md)                                                   | Defines input routing, selection, tools, zoom, keyboard behavior, undo, and accessibility.                         |
| [Toolbar and Stylebar](03-toolbar-and-stylebar.md)                                                     | Defines the production toolbar, contextual stylebar, responsive behavior, and mockup contract.                     |
| [Architecture](04-architecture.md)                                                                     | Defines package boundaries, Obsidian integration, lifecycle, and shared note sessions.                             |
| [Anchors and Layout](05-anchors-and-layout.md)                                                         | Defines note coordinates, automatic text binding, anchors, variable-width reflow, and aligned backgrounds.         |
| [SVG Rendering](06-svg-rendering.md)                                                                   | Defines retained SVG rendering, hit testing, culling, caches, and performance rules.                               |
| [Sidecar Persistence](07-sidecar-persistence.md)                                                       | Defines sidecar naming, schema, YAML marker, saves, conflicts, and recovery.                                       |
| [Settings](08-settings.md)                                                                             | Defines every setting, its group, default, scope, and persistence location.                                        |
| [Quality and Performance](09-quality-and-performance.md)                                               | Defines code-quality gates, resource limits, benchmarks, security, and privacy.                                    |
| [Testing and Acceptance](10-testing-and-acceptance.md)                                                 | Defines unit, integration, Android, accessibility, fault, and performance acceptance tests.                        |
| [Implementation Roadmap](11-implementation-roadmap.md)                                                 | Defines staged delivery and exit criteria.                                                                         |
| [Toolbar Mockup](12-toolbar-mockup.md)                                                                 | Explains the interactive toolbar and stylebar reference implementation.                                            |
| [References](13-references.md)                                                                         | Lists official Obsidian sources and excluded implementation inputs.                                                |
| [Obsidian Host Contract](14-obsidian-host-contract.md)                                                 | Defines packaging, host APIs, lifecycle, workspace, editor, UI, Vault, Android, and release integration.           |
| [Domain Model and Codecs](15-domain-model-and-codecs.md)                                               | Defines canonical scene, element, style, geometry, identity, ordering, attachment, and codec records.              |
| [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md)                           | Defines reversible operations, session admission, host effects, recovery records, and the recovery-store contract. |
| [GitHub and CI](17-github-and-ci.md)                                                                   | Defines the practical GitHub, dependency-update, CI, and release configuration.                                    |
| [Source Coordination and Persistence Operations](18-source-coordination-and-persistence-operations.md) | Defines offset maps, source admission, initial-sidecar state, and relocation or removal validation.                |
| [Features and Settings Overview](19-feature-and-settings-overview.md)                                  | Provides a short, non-normative summary of planned features, controls, and settings.                               |

## Authority and Change Control

Each subject has one owning document. Other documents link to that owner instead of redefining its contract. When an implementation decision changes observable behavior, persistence, compatibility, security, or package boundaries, the owning document MUST be updated in the same change.

[Quality and Performance](09-quality-and-performance.md#221-implementation-continuity-gate) owns the common implementation-continuity gate. [Testing and Acceptance](10-testing-and-acceptance.md#11-implementation-continuity-acceptance) defines how existing executable and structural checks apply that gate. [Implementation Roadmap](11-implementation-roadmap.md) names only the phase-specific owners and handoffs that the common gate evaluates.

| Subject                                                                               | Owning document                                                                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Product capability and exclusions                                                     | [Product Scope](01-product-scope.md)                                                                   |
| Input routing and tool behavior                                                       | [Interaction and Tools](02-interaction-and-tools.md)                                                   |
| Toolbar and stylebar presentation                                                     | [Toolbar and Stylebar](03-toolbar-and-stylebar.md)                                                     |
| Package, process, ownership, and lifecycle boundaries                                 | [Architecture](04-architecture.md)                                                                     |
| Binding, anchor, layout, and background algorithms                                    | [Anchors and Layout](05-anchors-and-layout.md)                                                         |
| Projection, retained SVG, culling, and hit testing                                    | [SVG Rendering](06-svg-rendering.md)                                                                   |
| Sidecar envelope, Vault writes, conflicts, and relocation                             | [Sidecar Persistence](07-sidecar-persistence.md)                                                       |
| User settings and defaults                                                            | [Settings](08-settings.md)                                                                             |
| Quality, security, resource, performance, and implementation-continuity gates         | [Quality and Performance](09-quality-and-performance.md)                                               |
| Verification and acceptance tests                                                     | [Testing and Acceptance](10-testing-and-acceptance.md)                                                 |
| Delivery order and phase exit criteria                                                | [Implementation Roadmap](11-implementation-roadmap.md)                                                 |
| Obsidian API, package, and release boundaries                                         | [Obsidian Host Contract](14-obsidian-host-contract.md)                                                 |
| Canonical scene and wire records                                                      | [Domain Model and Codecs](15-domain-model-and-codecs.md)                                               |
| Operations, sessions, host effects, recovery records, and recovery-store behavior     | [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md)                           |
| GitHub, dependency updates, CI, and releases                                          | [GitHub and CI](17-github-and-ci.md)                                                                   |
| Offset maps, source admission, initial sidecars, and relocation or removal validation | [Source Coordination and Persistence Operations](18-source-coordination-and-persistence-operations.md) |

This directory deliberately contains its own subject index. The complete project documentation index is maintained in the project-root `AGENTS.md`.
