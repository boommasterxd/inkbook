import { writeAutoPaintAttribute } from "../auto-paint-definitions";

interface HandoffEntry {
  readonly group: SVGGElement | null;
  readonly paths: readonly { readonly node: SVGPathElement }[];
}
interface HeldRoot extends SVGElement {
  inkbookLivePaintOwner?: SVGDefsElement;
}
const HOLD = "data-inkbook-live-handoff";

/** One logical replacement remains hidden until every Auto-painted part is ready. */
export function readyLivePaint(
  entry: HandoffEntry | undefined,
  canPaint: (node: SVGElement) => boolean,
  defs: SVGDefsElement,
): boolean {
  if (entry === undefined) return false;
  const ready = entry.paths.every(({ node }) => canPaint(node));
  if (entry.group !== null) hold(entry.group, ready, defs);
  else for (const { node } of entry.paths) hold(node, ready, defs);
  return ready;
}

export function releaseLivePaintHold(node: SVGElement): void {
  const root = node as HeldRoot;
  const owner = root.inkbookLivePaintOwner;
  if (owner === undefined) return;
  writeAutoPaintAttribute(owner, root, HOLD, null);
  delete root.inkbookLivePaintOwner;
}

function hold(node: SVGElement, ready: boolean, defs: SVGDefsElement): void {
  if (ready) {
    releaseLivePaintHold(node);
    return;
  }
  const root = node as HeldRoot;
  if (root.inkbookLivePaintOwner !== undefined) return;
  root.inkbookLivePaintOwner = defs;
  writeAutoPaintAttribute(defs, root, HOLD, "");
}
