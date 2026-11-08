import { parseOpeningTag } from "../../../persistence/documents/svg-tag";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { configurePreviewSvg } from "./safe-preview-svg";
import { findStaticSvgTokenSteps } from "../../../persistence/export/static-svg-scanner";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

interface PreviewBuildOptions {
  readonly checkpoint: (initial?: boolean) => Promise<void> | undefined;
  readonly isCancelled: () => boolean;
  readonly workScheduler: WorkScheduler;
  readonly configureElement?: (element: Element) => void;
}

/** Only accepts a completely validated safe-envelope SVG, without importing unvalidated markup. */
export async function createPreviewSvgAsync(
  ownerDocument: Document,
  safeSvg: string,
  options: PreviewBuildOptions,
): Promise<SVGSVGElement | undefined> {
  const exhausted = (): boolean => options.workScheduler.shouldYield();
  const steps = buildPreviewSteps(ownerDocument, safeSvg, exhausted, options.configureElement);
  let initial = true;
  while (true) {
    const pending = options.checkpoint(initial);
    if (pending !== undefined) await pending;
    initial = false;
    if (options.isCancelled()) return undefined;
    const step = steps.next();
    if (step.done) return step.value;
  }
}

function* findToken(
  input: string,
  token: string,
  start: number,
  exhausted: () => boolean,
): Generator<void, number> {
  const offset = yield* findStaticSvgTokenSteps(input, token, start, exhausted);
  if (offset < 0) throw new Error("The validated Inkbook preview has incomplete markup.");
  return offset;
}

function appendElement(
  ownerDocument: Document,
  markup: string,
  parents: Element[],
  configureElement?: (element: Element) => void,
): Element {
  const tag = parseOpeningTag(markup, 0);
  if (tag === null || !["svg", "g", "path"].includes(tag.name)) {
    throw new Error("The validated Inkbook preview has unexpected markup.");
  }
  return appendParsedPreviewElement(ownerDocument, tag, parents, configureElement);
}

/** Creates one prevalidated SVG tag, sharing preview and export DOM ownership rules. */
export function appendParsedPreviewElement(
  ownerDocument: Document,
  tag: NonNullable<ReturnType<typeof parseOpeningTag>>,
  parents: Element[],
  configureElement?: (element: Element) => void,
): Element {
  const parent = parents[parents.length - 1];
  if (
    parent !== undefined &&
    tag.name === "g" &&
    tag.attributes.size === 1 &&
    tag.attributes.get("opacity") === "1"
  ) {
    // Neutral pressure groups retain their nesting without another DOM node.
    if (!tag.selfClosing) parents.push(parent);
    return parent;
  }
  const element = ownerDocument.createElementNS(SVG_NAMESPACE, tag.name);
  for (const [name, value] of tag.attributes) {
    element.setAttribute(name, value);
  }
  configureElement?.(element);
  parent?.append(element);
  if (!tag.selfClosing) parents.push(element);
  return element;
}

function* buildPreviewSteps(
  ownerDocument: Document,
  safeSvg: string,
  exhausted: () => boolean,
  configureElement?: (element: Element) => void,
): Generator<void, SVGSVGElement> {
  const parents: Element[] = [];
  let root: SVGSVGElement | undefined;
  let cursor = 0;
  while (cursor < safeSvg.length) {
    const start = yield* findToken(safeSvg, "<", cursor, exhausted);
    const end = yield* findToken(safeSvg, ">", start, exhausted);
    const markup = safeSvg.slice(start, end + 1);
    cursor = end + 1;
    if (markup.startsWith("<metadata") || markup.startsWith("<style")) {
      const closing = markup.startsWith("<metadata") ? "</metadata>" : "</style>";
      cursor = (yield* findToken(safeSvg, closing, cursor, exhausted)) + closing.length;
      continue;
    }
    if (markup.startsWith("</")) {
      parents.pop();
      if (parents.length === 0) break;
      continue;
    }
    const element = appendElement(ownerDocument, markup, parents, configureElement);
    root ??= element as SVGSVGElement;
    if (exhausted()) yield;
  }
  if (root?.localName !== "svg" || parents.length !== 0) {
    throw new Error("The validated Inkbook preview did not produce a complete SVG root.");
  }
  configurePreviewSvg(root);
  return root;
}
