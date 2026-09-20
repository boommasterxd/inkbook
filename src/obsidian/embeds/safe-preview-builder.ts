import { parseOpeningTag } from "../../persistence/documents/svg-tag";
import { DEFAULT_REFRESH_RATE, refreshRateProfile } from "../performance";
import { configurePreviewSvg } from "./safe-preview-svg";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const SCAN_UNITS = 16 * 1024;
const ELEMENTS_PER_SLICE = 32;
const DEFAULT_SLICE_BUDGET_MS = refreshRateProfile(DEFAULT_REFRESH_RATE).sliceBudgetMs;

interface PreviewBuildOptions {
  readonly checkpoint: () => Promise<void>;
  readonly isCancelled: () => boolean;
  readonly now?: () => number;
  readonly sliceBudgetMs?: () => number;
}

/** Only accepts a completely validated safe-envelope SVG, without importing unvalidated markup. */
export async function createPreviewSvgAsync(
  ownerDocument: Document,
  safeSvg: string,
  options: PreviewBuildOptions,
): Promise<SVGSVGElement | undefined> {
  const now = options.now ?? (() => performance.now());
  const sliceBudgetMs = options.sliceBudgetMs ?? (() => DEFAULT_SLICE_BUDGET_MS);
  let sliceStarted = now();
  const deadlineExceeded = () => now() - sliceStarted >= sliceBudgetMs();
  const steps = buildPreviewSteps(ownerDocument, safeSvg, deadlineExceeded);
  while (true) {
    await options.checkpoint();
    if (options.isCancelled()) return undefined;
    sliceStarted = now();
    const step = steps.next();
    if (step.done) return step.value;
  }
}

function* findToken(
  input: string,
  token: string,
  start: number,
  deadlineExceeded: () => boolean,
): Generator<void, number> {
  for (let cursor = start; cursor < input.length; cursor += SCAN_UNITS) {
    const chunk = input.slice(cursor, cursor + SCAN_UNITS + token.length - 1);
    const offset = chunk.indexOf(token);
    if (offset >= 0) {
      if (deadlineExceeded()) yield;
      return cursor + offset;
    }
    yield;
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
  deadlineExceeded: () => boolean,
): Generator<void, SVGSVGElement> {
  const parents: Element[] = [];
  let root: SVGSVGElement | undefined;
  let cursor = 0;
  let elements = 0;
  let markupUnits = 0;
  while (cursor < safeSvg.length) {
    const start = yield* findToken(safeSvg, "<", cursor, deadlineExceeded);
    const end = yield* findToken(safeSvg, ">", start, deadlineExceeded);
    const markup = safeSvg.slice(start, end + 1);
    cursor = end + 1;
    if (markup.startsWith("<metadata") || markup.startsWith("<style")) {
      const closing = markup.startsWith("<metadata") ? "</metadata>" : "</style>";
      cursor = (yield* findToken(safeSvg, closing, cursor, deadlineExceeded)) + closing.length;
      continue;
    }
    if (markup.startsWith("</")) {
      parents.pop();
      if (parents.length === 0) break;
      continue;
    }
    const element = appendElement(ownerDocument, markup, parents);
    root ??= element as SVGSVGElement;
    elements += 1;
    markupUnits += markup.length;
    if (elements >= ELEMENTS_PER_SLICE || markupUnits >= SCAN_UNITS || deadlineExceeded()) {
      elements = 0;
      markupUnits = 0;
      yield;
    }
  }
  if (root?.localName !== "svg" || parents.length !== 0) {
    throw new Error("The validated Inkbook preview did not produce a complete SVG root.");
  }
  configurePreviewSvg(root);
  return root;
}
