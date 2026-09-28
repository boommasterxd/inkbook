import { parseOpeningTag } from "../../persistence/documents/svg-tag";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { configurePreviewSvg } from "./safe-preview-svg";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const SCAN_UNITS = 16 * 1024;

interface PreviewBuildOptions {
  readonly checkpoint: (initial?: boolean) => Promise<void>;
  readonly isCancelled: () => boolean;
  readonly workScheduler: WorkScheduler;
}

/** Only accepts a completely validated safe-envelope SVG, without importing unvalidated markup. */
export async function createPreviewSvgAsync(
  ownerDocument: Document,
  safeSvg: string,
  options: PreviewBuildOptions,
): Promise<SVGSVGElement | undefined> {
  const exhausted = (): boolean => options.workScheduler.shouldYield();
  const steps = buildPreviewSteps(ownerDocument, safeSvg, exhausted);
  let initial = true;
  while (true) {
    await options.checkpoint(initial);
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
  for (let cursor = start; cursor < input.length; cursor += SCAN_UNITS) {
    const chunk = input.slice(cursor, cursor + SCAN_UNITS + token.length - 1);
    const offset = chunk.indexOf(token);
    if (exhausted()) yield;
    if (offset >= 0) return cursor + offset;
  }
  throw new Error("The validated Inkbook preview has incomplete markup.");
}

function appendElement(ownerDocument: Document, markup: string, parents: Element[]): Element {
  const tag = parseOpeningTag(markup, 0);
  if (tag === null || !["svg", "g", "path"].includes(tag.name)) {
    throw new Error("The validated Inkbook preview has unexpected markup.");
  }
  const element = ownerDocument.createElementNS(SVG_NAMESPACE, tag.name);
  for (const [name, value] of tag.attributes) {
    element.setAttribute(name, value);
  }
  parents[parents.length - 1]?.append(element);
  if (!tag.selfClosing) parents.push(element);
  return element;
}

function* buildPreviewSteps(
  ownerDocument: Document,
  safeSvg: string,
  exhausted: () => boolean,
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
    const element = appendElement(ownerDocument, markup, parents);
    root ??= element as SVGSVGElement;
    if (exhausted()) yield;
  }
  if (root?.localName !== "svg" || parents.length !== 0) {
    throw new Error("The validated Inkbook preview did not produce a complete SVG root.");
  }
  configurePreviewSvg(root);
  return root;
}
