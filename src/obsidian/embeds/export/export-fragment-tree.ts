import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { StaticExportFragment } from "../../../persistence/export/static-export-fragments";
import { consumeSerializationSteps } from "../../../persistence/serialization/output/serialization-model-preparation";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
// Small reference groups avoid one additional SVG container for every saved path.
const FRAGMENTS_PER_LEAF = 32;
// A synchronous print publication admits a bounded reference graph, or one complete drawing.
const MAXIMUM_PAGE_REFERENCES = 128;
const MAXIMUM_PAGE_RANGE_READS = MAXIMUM_PAGE_REFERENCES * 4;

interface FragmentRange {
  readonly id: string;
  readonly minY: number;
  readonly maxY: number;
}

export interface ExportFragmentTree extends FragmentRange {
  readonly latestStart: number;
  readonly earliestEnd: number;
  readonly children: readonly ExportFragmentTree[];
  readonly entries: readonly FragmentRange[];
}

interface BuildNode {
  readonly element: SVGGElement;
  readonly tree: ExportFragmentTree;
}

/** Index only the validated static graphic, preserving its bands and opacity groups. */
export async function retainExportFragments(
  drawing: SVGGElement,
  fragments: readonly StaticExportFragment[],
  options: { readonly scheduler: WorkScheduler; readonly signal: AbortSignal },
): Promise<readonly ExportFragmentTree[] | undefined> {
  const bands = Array.from(drawing.children);
  if (bands.reduce((count, band) => count + band.children.length, 0) !== fragments.length)
    return undefined;
  return consumeSerializationSteps(buildFragmentTrees(drawing, bands, fragments), {
    signal: options.signal,
    checkpoint: () => options.scheduler.checkpoint(options.signal, "background"),
  });
}

function* buildFragmentTrees(
  drawing: SVGGElement,
  bands: readonly Element[],
  fragments: readonly StaticExportFragment[],
): Generator<void, readonly ExportFragmentTree[]> {
  const trees: ExportFragmentTree[] = [];
  let ordinal = 0;
  let nextGroup = 0;
  const groupId = () => `${drawing.id}-group-${nextGroup++}`;
  for (const band of bands) {
    const leaves: BuildNode[] = [];
    while (band.firstElementChild !== null) {
      const element = drawing.ownerDocument.createElementNS(SVG_NAMESPACE, "g");
      const entries: FragmentRange[] = [];
      while (entries.length < FRAGMENTS_PER_LEAF && band.firstElementChild !== null) {
        const child = band.firstElementChild;
        const bounds = fragments[ordinal]!;
        const id = `${drawing.id}-fragment-${ordinal++}`;
        child.setAttribute("id", id);
        element.append(child);
        entries.push({
          id,
          minY: bounds.background ? -Infinity : bounds.minY,
          maxY: bounds.background ? Infinity : bounds.maxY,
        });
        yield;
      }
      leaves.push(buildNode(element, entries, [], groupId()));
    }
    const node = yield* combineNodes(leaves, groupId);
    if (node !== undefined) {
      band.append(node.element);
      trees.push(node.tree);
    }
  }
  return trees;
}

function* combineNodes(
  input: readonly BuildNode[],
  groupId: () => string,
): Generator<void, BuildNode | undefined> {
  let nodes = input;
  while (nodes.length > 1) {
    const parents: BuildNode[] = [];
    for (let index = 0; index < nodes.length; index += 2) {
      const left = nodes[index]!;
      const right = nodes[index + 1];
      if (right === undefined) parents.push(left);
      else {
        const element = left.element.ownerDocument.createElementNS(SVG_NAMESPACE, "g");
        element.append(left.element, right.element);
        parents.push(buildNode(element, [], [left.tree, right.tree], groupId()));
      }
      yield;
    }
    nodes = parents;
  }
  return nodes[0];
}

function buildNode(
  element: SVGGElement,
  entries: readonly FragmentRange[],
  children: readonly ExportFragmentTree[],
  id: string,
): BuildNode {
  element.setAttribute("id", id);
  const ranges = children.length === 0 ? entries : children;
  return {
    element,
    tree: {
      id,
      minY: Math.min(...ranges.map((range) => range.minY)),
      maxY: Math.max(...ranges.map((range) => range.maxY)),
      latestStart: Math.max(
        ...(children.length === 0
          ? entries.map((range) => range.minY)
          : children.map((range) => range.latestStart)),
      ),
      earliestEnd: Math.min(
        ...(children.length === 0
          ? entries.map((range) => range.maxY)
          : children.map((range) => range.earliestEnd)),
      ),
      children,
      entries,
    },
  };
}

/** Ordered subtree references select every intersecting fragment without copying paths. */
export function exportFragmentReferences(
  trees: readonly ExportFragmentTree[],
  start: number,
  end: number,
  fallbackId: string,
): readonly string[] {
  const references: string[] = [];
  const admission = { remaining: MAXIMUM_PAGE_RANGE_READS };
  for (const id of visitFragmentReferences(trees, start, end, admission)) {
    if (references.length === MAXIMUM_PAGE_REFERENCES) return [fallbackId];
    references.push(id);
  }
  return admission.remaining < 0 ? [fallbackId] : references;
}

function* visitFragmentReferences(
  trees: readonly ExportFragmentTree[],
  start: number,
  end: number,
  admission: { remaining: number },
): Generator<string> {
  for (const tree of trees) {
    if (--admission.remaining < 0) return;
    if (tree.minY > end || tree.maxY < start) continue;
    if (tree.latestStart <= end && tree.earliestEnd >= start) yield tree.id;
    else if (tree.children.length > 0) {
      yield* visitFragmentReferences(tree.children, start, end, admission);
      if (admission.remaining < 0) return;
    } else {
      for (const entry of tree.entries) {
        if (--admission.remaining < 0) return;
        if (entry.minY <= end && entry.maxY >= start) yield entry.id;
      }
    }
  }
}
