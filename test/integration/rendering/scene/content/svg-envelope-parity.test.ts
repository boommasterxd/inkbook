import { describe, expect, it } from "vitest";

import { deriveRenderBands } from "../../../../../src/domain/commands/render-bands";
import { backgroundGuideLayout } from "../../../../../src/domain/geometry/public";
import { calculateElementBounds } from "../../../../../src/domain/geometry/public";
import type {
  BackgroundV1,
  InkElementV1,
  InkSnapshotV1,
} from "../../../../../src/domain/schema/public";
import { PORTABLE_PALETTE_V1 } from "../../../../../src/domain/schema/public";
import { validateSafeSvg } from "../../../../../src/persistence/documents/safe-svg-validator";
import { serializeSvgNumber } from "../../../../../src/persistence/documents/svg-number";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/public";
import { SvgSceneRenderer } from "../../../../../src/rendering/scene";
import { SceneBackgroundCache } from "../../../../../src/rendering/scene/content/background-cache";
import { type SceneElementRecord } from "../../../../../src/rendering/scene/types";
import type { InkbookColorScheme } from "../../../../../src/obsidian/theme/color-scheme";
import {
  createAllElementSnapshot,
  uuid,
} from "../../../../unit/persistence/serialization/fixtures";
import {
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  FakeScheduler,
  asElement,
  fakeNode,
} from "../../../../unit/rendering/scene/fakes";

type Attributes = ReadonlyMap<string, string>;

interface Segment {
  readonly x1: number;
  readonly x2: number;
  readonly y1: number;
  readonly y2: number;
}

const BACKGROUNDS: readonly BackgroundV1[] = [
  { type: "none" },
  { spacing: 100, type: "lines" },
  { spacing: 100, type: "dots" },
  { spacing: 100, type: "squares" },
  { spacing: 50, type: "squares" },
];

describe("active and standalone SVG graphic parity", () => {
  it.each(["light", "dark"] as const)(
    "matches every element, style, and arrow-node presentation in %s mode",
    (scheme) => {
      const snapshot = representativeSnapshot();
      const { safe, standalone } = serializeValidatedSnapshot(snapshot);

      const scene = renderScene(snapshot, standalone.lockedHeight, scheme);
      const active = activeBandPaths(scene.renderer);
      const saved = {
        content: parsePathMarkup(
          standalone.svg.slice(safe.groups.content.start, safe.groups.content.end),
        ),
        highlight: parsePathMarkup(
          standalone.svg.slice(safe.groups.highlights.start, safe.groups.highlights.end),
        ),
      };

      expect(active.highlight.map((path) => semanticPath(path, scheme))).toEqual(
        saved.highlight.map((path) => semanticPath(path, scheme)),
      );
      expect(active.content.map((path) => semanticPath(path, scheme))).toEqual(
        saved.content.map((path) => semanticPath(path, scheme)),
      );
      expect(active.highlight.length + active.content.length).toBeGreaterThan(
        snapshot.elements.length,
      );
      scene.renderer.destroy();
    },
  );

  it.each(BACKGROUNDS)(
    "matches the active $type background pattern to standalone guide geometry",
    verifyBackgroundParity,
  );

  it("uses the square guide palette for every patterned background", () => {
    for (const scheme of ["light", "dark"] as const) {
      const resolved = BACKGROUNDS.filter(
        (background): background is Exclude<BackgroundV1, { type: "none" }> =>
          background.type !== "none",
      ).map((background) => {
        const snapshot = representativeSnapshot();
        snapshot.page.background = background;
        const { standalone } = serializeValidatedSnapshot(snapshot);
        const scene = renderScene(snapshot, standalone.lockedHeight, scheme);
        const active = activeBackground(scene.renderer);
        const guide = styleValue(scene.renderer, "--inkbook-guide");
        const fallback = active.patternPath.get("stroke");
        scene.renderer.destroy();
        return { fallback, guide };
      });

      expect(resolved.every(({ guide }) => guide === PORTABLE_PALETTE_V1[scheme].guide)).toBe(true);
      expect(resolved.every(({ fallback }) => fallback === PORTABLE_PALETTE_V1.light.guide)).toBe(
        true,
      );
    }
  });
});

function verifyBackgroundParity(background: BackgroundV1): void {
  const snapshot = representativeSnapshot();
  snapshot.page.background = background;
  const { safe, standalone } = serializeValidatedSnapshot(snapshot);
  const saved = parsePathMarkup(
    standalone.svg.slice(safe.groups.background.start, safe.groups.background.end),
  );
  const savedPage = saved[0];
  expect(savedPage).toBeDefined();
  if (savedPage === undefined) return;

  for (const scheme of ["light", "dark"] as const) {
    const scene = renderScene(snapshot, standalone.lockedHeight, scheme);
    const active = activeBackground(scene.renderer);
    expect(semanticPath(active.page, scheme)).toEqual(semanticPath(savedPage, scheme));
    expect(styleValue(scene.renderer, "--inkbook-page")).toBe(PORTABLE_PALETTE_V1[scheme].page);
    expect(styleValue(scene.renderer, "--inkbook-guide")).toBe(PORTABLE_PALETTE_V1[scheme].guide);

    const savedSegments = saved.slice(1).flatMap((path) => pathSegments(path.get("d") ?? ""));
    if (background.type === "none") {
      expect(savedSegments).toEqual([]);
      expect(active.coverage.get("fill")).toBe("none");
      expect(active.patternPath.get("d")).toBe("");
    } else {
      verifyPatternedBackground(
        active,
        background,
        snapshot,
        standalone.lockedHeight,
        saved,
        savedSegments,
      );
    }
    scene.renderer.destroy();
  }
}

function verifyPatternedBackground(
  active: ReturnType<typeof activeBackground>,
  background: Exclude<BackgroundV1, { type: "none" }>,
  snapshot: InkSnapshotV1,
  lockedHeight: number,
  saved: Attributes[],
  savedSegments: Segment[],
): void {
  const layout = backgroundGuideLayout({
    background,
    innerWidth: snapshot.page.innerWidth,
    margin: snapshot.page.margin,
    pageHeight: lockedHeight,
  });
  const inset = background.type === "dots" ? 1 : 0.5;
  expect(active.coverage.get("d")).toBe(
    `M ${serializeSvgNumber(layout.left - inset)} ${serializeSvgNumber(layout.top - inset)} ` +
      `H ${serializeSvgNumber(layout.right + inset)} ` +
      `V ${serializeSvgNumber(layout.bottom + inset)} ` +
      `H ${serializeSvgNumber(layout.left - inset)} Z`,
  );
  expect(active.coverage.get("fill")).toMatch(/^url\(#inkbook-background-pattern-/u);
  expect(active.pattern.get("x")).toBe(
    serializeSvgNumber(layout.left - (background.type === "lines" ? 0 : inset)),
  );
  expect(active.pattern.get("y")).toBe(serializeSvgNumber(layout.top - inset));
  expect(active.pattern.get("width")).toBe(String(background.spacing));
  expect(active.pattern.get("height")).toBe(String(background.spacing));
  expect(active.patternPath.get("class")).toBe("inkbook-theme-guide");
  expect(active.patternPath.get("stroke")).toBe(PORTABLE_PALETTE_V1.light.guide);
  expect(active.patternPath.has("vector-effect")).toBe(false);
  expect(Number(active.patternPath.get("stroke-width"))).toBe(background.type === "dots" ? 2 : 1);
  const cached = new SceneBackgroundCache().resolve({
    background,
    innerWidth: snapshot.page.innerWidth,
    margin: snapshot.page.margin,
    pageHeight: lockedHeight,
  });
  expect(active.edge.get("d") ?? "").toBe(cached.edgeD);
  expect(active.edge.get("stroke-dasharray") ?? null).toBe(
    background.type === "dots" ? `0 ${String(background.spacing)}` : null,
  );
  expect(saved.slice(1).every((path) => !path.has("vector-effect"))).toBe(true);
  expect(activePatternSegments(background, layout)).toEqual(savedSegments);
}

function serializeValidatedSnapshot(snapshot: InkSnapshotV1) {
  const result = serializeInkbookDocument(snapshot);
  expect(result.ok, result.ok ? "" : JSON.stringify(result.error)).toBe(true);
  if (!result.ok) throw new Error("Expected representative snapshot serialization to succeed.");
  const safe = validateSafeSvg(result.value.svg);
  expect(safe).not.toBeNull();
  if (safe === null) throw new Error("Expected a safe standalone SVG envelope.");
  return { safe, standalone: result.value };
}

function representativeSnapshot(): InkSnapshotV1 {
  const snapshot = createAllElementSnapshot();
  const first = snapshot.elements[0];
  if (first?.kind === "straight-highlighter") {
    first.style = { ...first.style, opacity: 0.1234 };
  }
  const rectangle = snapshot.elements.find((element) => element.kind === "rectangle");
  if (rectangle?.kind === "rectangle") {
    rectangle.style = { ...rectangle.style, fillOpacity: 0.0001, outlineOpacity: 0 };
  }
  snapshot.elements.splice(1, 0, freehandHighlighter(15));
  snapshot.elements.push(
    arrow(13, 700, "arrow", "diamond", { type: "theme-text" }),
    arrow(14, 900, "none", "none", { type: "rgba", value: "#00AA66CC" }),
  );
  return snapshot;
}

function arrow(
  id: number,
  y: number,
  startNode: "arrow" | "none",
  endNode: "diamond" | "none",
  outlineColor:
    { readonly type: "theme-text" } | { readonly type: "rgba"; readonly value: `#${string}` },
): InkElementV1 {
  return {
    bend: { x: 350, y: y - 40 },
    createdAt: id,
    end: { x: 500, y },
    endConnection: null,
    endNode,
    id: uuid(id),
    kind: "arrow",
    pivot: { x: 350, y },
    rotation: 15,
    start: { x: 200, y },
    startConnection: null,
    startNode,
    style: {
      outlineColor,
      outlineOpacity: id === 13 ? 0.0001 : 1,
      outlineStyle: id === 13 ? "dashed" : "solid",
      outlineWidth: 8,
    },
  };
}

function freehandHighlighter(id: number): InkElementV1 {
  return {
    createdAt: id,
    id: uuid(id),
    kind: "stroke",
    pivot: { x: 800, y: 650 },
    points: [700, 650, 0.5, 800, 670, 0.5, 900, 650, 0.5],
    rotation: 0,
    style: {
      color: { type: "rgba", value: "#FFCC0080" },
      opacity: 1,
      pressureEnabled: false,
      smoothing: 0.5,
      width: 22,
    },
    tool: "highlighter",
  };
}

function renderScene(
  snapshot: InkSnapshotV1,
  lockedHeight: number,
  scheme: InkbookColorScheme,
): { readonly renderer: SvgSceneRenderer } {
  const document = new FakeDocument();
  const container = new FakeNode(document, "div");
  const scheduler = new FakeScheduler();
  const store = sceneStore(snapshot.elements);
  const renderer = new SvgSceneRenderer({
    container: asElement(container),
    inputHandlers: {},
    layout: {
      readViewport: () => ({ height: lockedHeight, left: 0, top: 0, width: 2048.6 }),
    },
    page: snapshot.page,
    workScheduler: scheduler.workScheduler,
    store,
  });
  renderer.setPage(snapshot.page, lockedHeight);
  renderer.setScheme(scheme);
  scheduler.runAll();
  return { renderer };
}

function sceneStore(elements: readonly InkElementV1[]): FakeSceneStore {
  const store = new FakeSceneStore();
  const bands = deriveRenderBands(elements);
  for (const band of ["highlight", "content"] as const) {
    for (const [rank, element] of bands[band].entries()) {
      const record: SceneElementRecord = {
        band,
        bounds: calculateElementBounds(element),
        element,
        geometryVersion: 1,
        id: element.id,
        paintVersion: 1,
        rank,
      };
      store.records.set(element.id, record);
    }
  }
  return store;
}

function activeBandPaths(renderer: SvgSceneRenderer): {
  readonly content: Attributes[];
  readonly highlight: Attributes[];
} {
  const camera = sceneCamera(renderer);
  return {
    content: childAttributes(camera.nodes[4]),
    highlight: childAttributes(camera.nodes[3]),
  };
}

function activeBackground(renderer: SvgSceneRenderer): {
  readonly coverage: Attributes;
  readonly edge: Attributes;
  readonly page: Attributes;
  readonly pattern: Attributes;
  readonly patternPath: Attributes;
} {
  const svg = fakeNode(renderer.svg);
  const camera = sceneCamera(renderer);
  const definitions = requiredNode(svg.nodes[3], "defs");
  const pattern = requiredNode(definitions.nodes[0], "pattern");
  return {
    coverage: requiredNode(camera.nodes[1], "path").attributes,
    edge: requiredNode(camera.nodes[2], "path").attributes,
    page: requiredNode(camera.nodes[0], "path").attributes,
    pattern: pattern.attributes,
    patternPath: requiredNode(pattern.nodes[0], "path").attributes,
  };
}

function sceneCamera(renderer: SvgSceneRenderer): FakeNode {
  return requiredNode(fakeNode(renderer.svg).nodes[1], "g");
}

function childAttributes(node: FakeNode | undefined): Attributes[] {
  return requiredNode(node, "g").nodes.flatMap((child) => {
    if (child.tagName === "path") return [child.attributes];
    return requiredNode(child, "g").nodes.map((path) => {
      const attributes = new Map(requiredNode(path, "path").attributes);
      attributes.set("opacity", child.attributes.get("opacity") ?? "1");
      return attributes;
    });
  });
}

function requiredNode(node: FakeNode | undefined, tagName: string): FakeNode {
  if (node === undefined || node.tagName !== tagName) {
    throw new Error(`Expected ${tagName} scene node.`);
  }
  return node;
}

function parsePathMarkup(markup: string): Attributes[] {
  const paths: Attributes[] = [];
  let groupOpacity = "1";
  for (const match of markup.matchAll(/<(path|g) ([^>]+)>|<\/g>/gu)) {
    const attributes = new Map(
      [...(match[2] ?? "").matchAll(/([a-z-]+)="([^"]*)"/gu)].map(
        (attribute) => [attribute[1]!, attribute[2]!] as const,
      ),
    );
    if (match[1] !== "path") groupOpacity = attributes.get("opacity") ?? "1";
    else paths.push(new Map([...attributes, ["opacity", groupOpacity]]));
  }
  return paths;
}

function semanticPath(attributes: Attributes, scheme: InkbookColorScheme): object {
  const className = attributes.get("class") ?? null;
  return {
    className,
    opacity: attributes.get("opacity") ?? "1",
    d: pathTokens(attributes.get("d") ?? ""),
    fill: resolvedPaint(attributes.get("fill") ?? "#000000FF", className, "fill", scheme),
    fillOpacity: attributes.get("fill-opacity") ?? "1",
    fillRule: attributes.get("fill-rule") ?? "nonzero",
    lineCap: attributes.get("stroke-linecap") ?? "butt",
    lineJoin: attributes.get("stroke-linejoin") ?? "miter",
    stroke: resolvedPaint(attributes.get("stroke") ?? "none", className, "stroke", scheme),
    strokeDasharray: attributes.get("stroke-dasharray") ?? "none",
    strokeOpacity: attributes.get("stroke-opacity") ?? "1",
    strokeWidth: attributes.get("stroke-width") ?? "1",
  };
}

function resolvedPaint(
  fallback: string,
  className: string | null,
  paint: "fill" | "stroke",
  scheme: InkbookColorScheme,
): string {
  if (className === "inkbook-theme-page" && paint === "fill") {
    return PORTABLE_PALETTE_V1[scheme].page;
  }
  if (className === "inkbook-theme-guide" && paint === "stroke") {
    return PORTABLE_PALETTE_V1[scheme].guide;
  }
  if (className === `inkbook-theme-${paint}` || className === "inkbook-theme-stroke-fill") {
    return PORTABLE_PALETTE_V1[scheme].text;
  }
  return fallback;
}

function pathTokens(path: string): readonly string[] {
  return [...path.matchAll(/[A-Z]|-?(?:0|[1-9]\d*)(?:\.\d+)?/gu)].map((match) => match[0]);
}

function pathSegments(path: string): Segment[] {
  const tokens = pathTokens(path);
  const segments: Segment[] = [];
  for (let index = 0; index < tokens.length;) {
    if (tokens[index] !== "M") throw new Error("Expected background move command.");
    const x1 = Number(tokens[index + 1]);
    const y1 = Number(tokens[index + 2]);
    if (tokens[index + 3] !== "L") throw new Error("Expected background line command.");
    const x2 = Number(tokens[index + 4]);
    const y2 = Number(tokens[index + 5]);
    segments.push({ x1, x2, y1, y2 });
    index += 6;
  }
  return segments;
}

function activePatternSegments(
  background: Exclude<BackgroundV1, { type: "none" }>,
  layout: ReturnType<typeof backgroundGuideLayout>,
): Segment[] {
  const segments: Segment[] = [];
  for (let yIndex = 0; yIndex < layout.verticalPointCount; yIndex += 1) {
    const y = guidePoint(
      layout.vertical,
      layout.verticalSpacing,
      yIndex,
      layout.verticalPointCount,
    );
    if (background.type === "dots") {
      for (let xIndex = 0; xIndex < layout.horizontalPointCount; xIndex += 1) {
        const x = guidePoint(
          layout.horizontal,
          layout.horizontalSpacing,
          xIndex,
          layout.horizontalPointCount,
        );
        segments.push(segment(x, y, x, y));
      }
    } else {
      segments.push(segment(layout.left, y, layout.right, y));
    }
  }
  if (background.type === "squares") {
    for (let xIndex = 0; xIndex < layout.horizontalPointCount; xIndex += 1) {
      const x = guidePoint(
        layout.horizontal,
        layout.horizontalSpacing,
        xIndex,
        layout.horizontalPointCount,
      );
      segments.push(segment(x, layout.top, x, layout.bottom));
    }
  }
  return segments;
}

function guidePoint(
  axis: { readonly end: number; readonly start: number },
  spacing: number,
  index: number,
  count: number,
): number {
  return index === count - 1 ? axis.end : axis.start + index * spacing;
}

function segment(x1: number, y1: number, x2: number, y2: number): Segment {
  return {
    x1: Number(serializeSvgNumber(x1)),
    x2: Number(serializeSvgNumber(x2)),
    y1: Number(serializeSvgNumber(y1)),
    y2: Number(serializeSvgNumber(y2)),
  };
}

function styleValue(renderer: SvgSceneRenderer, property: string): unknown {
  return fakeNode(renderer.svg).style[property];
}
