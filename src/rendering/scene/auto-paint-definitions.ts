import type { Bounds } from "../../domain/geometry/primitives";
import { AUTO_CONTRAST_MATRIX } from "../../domain/images/auto-contrast";
import { SVG_NAMESPACE } from "./constants";
import type { MutableSceneInstrumentation } from "./types";

interface PaintOwner extends SVGDefsElement {
  inkbookAutoPaintInstrumentation?: MutableSceneInstrumentation;
}

export function bindAutoPaintInstrumentation(
  defs: SVGDefsElement,
  value: MutableSceneInstrumentation,
): void {
  (defs as PaintOwner).inkbookAutoPaintInstrumentation = value;
}

export function recordAutoPaintWrite(defs: SVGDefsElement): void {
  const value = (defs as PaintOwner).inkbookAutoPaintInstrumentation;
  if (value === undefined) return;
  value.attributeWrites += 1;
  value.contentAttributeWrites += 1;
}

export function writeAutoPaintAttribute(
  defs: SVGDefsElement,
  node: SVGElement,
  name: string,
  value: string | null,
): void {
  if (value === null) node.removeAttribute(name);
  else node.setAttribute(name, value);
  recordAutoPaintWrite(defs);
}

export interface AutoPaintDefinitions {
  readonly root: SVGGElement;
  readonly pattern: SVGPatternElement;
  readonly filter: SVGFilterElement;
  readonly patternId: string;
  readonly underlayId: string;
  readonly source: SVGUseElement;
  readonly owner: SVGDefsElement;
}

export interface AutoPaintAlias {
  readonly pattern: SVGPatternElement;
  readonly patternId: string;
  readonly owner: SVGDefsElement;
}

let nextId = 0;

export function createAutoPaintDefinitions(
  defs: SVGDefsElement,
  page: SVGPathElement,
  images: SVGGElement,
  motionImages?: SVGGElement,
): AutoPaintDefinitions {
  const id = `inkbook-scene-auto-${String(++nextId)}`;
  const underlay = create(defs, "g", { id: `${id}-underlay` });
  const pageId = `${id}-page`;
  const imageId = `${id}-images`;
  writeAutoPaintAttribute(defs, page, "id", pageId);
  writeAutoPaintAttribute(defs, images, "id", imageId);
  underlay.append(create(defs, "use", { href: `#${pageId}` }));
  const imageUse = create(defs, "use", { href: `#${imageId}` });
  imageUse.style.setProperty("--inkbook-image-pixels-opacity", "0");
  imageUse.style.setProperty("--inkbook-image-substrate-opacity", "1");
  underlay.append(imageUse);
  if (motionImages !== undefined) underlay.append(motionImages);
  const definitions = createPaint(defs, id, `${id}-underlay`);
  definitions.root.prepend(underlay);
  return definitions;
}

export function createAutoPaintScope(
  defs: SVGDefsElement,
  shared: AutoPaintDefinitions,
): AutoPaintDefinitions {
  return createPaint(defs, `inkbook-scene-auto-${String(++nextId)}`, shared.underlayId);
}

export function createAutoPaintAlias(defs: SVGDefsElement): AutoPaintAlias {
  const patternId = `inkbook-scene-auto-${String(++nextId)}-alias`;
  const pattern = create(defs, "pattern", { id: patternId });
  defs.append(pattern);
  return { pattern, patternId, owner: defs };
}

function createPaint(defs: SVGDefsElement, id: string, underlayId: string): AutoPaintDefinitions {
  const root = create(defs, "g", { id: `${id}-definitions` });
  const filter = create(defs, "filter", {
    id: `${id}-filter`,
    filterUnits: "userSpaceOnUse",
    "color-interpolation-filters": "linearRGB",
  });
  filter.append(
    create(defs, "feColorMatrix", {
      values: AUTO_CONTRAST_MATRIX,
    }),
  );
  const transfer = create(defs, "feComponentTransfer", {});
  for (const name of ["feFuncR", "feFuncG", "feFuncB"] as const) {
    transfer.append(create(defs, name, { type: "discrete", tableValues: "0 1" }));
  }
  filter.append(transfer);
  const patternId = `${id}-pattern`;
  const pattern = create(defs, "pattern", {
    id: patternId,
    patternUnits: "userSpaceOnUse",
    preserveAspectRatio: "none",
  });
  const paint = create(defs, "g", { filter: `url(#${id}-filter)` });
  const source = create(defs, "use", { href: `#${underlayId}` });
  paint.append(source);
  pattern.append(paint);
  root.append(filter, pattern);
  defs.append(root);
  return { root, pattern, filter, patternId, underlayId, source, owner: defs };
}

export function setAutoPaintRegion(
  definitions: AutoPaintAlias & { readonly filter?: SVGFilterElement },
  region: Bounds,
): void {
  const { minX, minY, maxX, maxY } = region;
  const values = {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
  for (const [name, value] of Object.entries(values)) {
    writeAutoPaintAttribute(definitions.owner, definitions.pattern, name, String(value));
    if (definitions.filter !== undefined)
      writeAutoPaintAttribute(definitions.owner, definitions.filter, name, String(value));
  }
  writeAutoPaintAttribute(
    definitions.owner,
    definitions.pattern,
    "viewBox",
    `${values.x} ${values.y} ${values.width} ${values.height}`,
  );
}

function create<K extends keyof SVGElementTagNameMap>(
  owner: SVGDefsElement,
  name: K,
  attributes: Readonly<Record<string, string>>,
): SVGElementTagNameMap[K] {
  const node = owner.ownerDocument.createElementNS(SVG_NAMESPACE, name);
  for (const [key, value] of Object.entries(attributes))
    writeAutoPaintAttribute(owner, node, key, value);
  return node;
}
