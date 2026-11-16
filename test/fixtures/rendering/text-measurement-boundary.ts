import { vi } from "vitest";
import { CanvasTextMeasurer } from "../../../src/rendering/text/canvas-text-measurer";
import type {
  TextFontResourceBoundaries,
  TextFontResourceResolver,
} from "../../../src/rendering/text/text-layout-types";

export function nativeMetrics(width: number, ascent = 16, descent = 4) {
  return {
    width,
    actualBoundingBoxLeft: 0,
    actualBoundingBoxRight: width,
    actualBoundingBoxAscent: ascent,
    actualBoundingBoxDescent: descent,
    fontBoundingBoxAscent: ascent,
    fontBoundingBoxDescent: descent,
  };
}

export function measurementBoundary(
  resolveFontResourceId?: TextFontResourceResolver,
  fontResourceBoundaries?: TextFontResourceBoundaries,
  nativeLine = (_font: string, fontSize: number, _lineHeight: string) => ({
    ascent: fontSize * 0.95,
    lineHeight: fontSize * 1.3,
  }),
) {
  const context = {
    font: "",
    measureText: vi.fn((text: string) => nativeMetrics(text.length * 10)),
  };
  const canvas = { width: 300, height: 150, getContext: () => context };
  const createElement = vi.fn(() => canvas);
  const nativeDocument = document.implementation.createHTMLDocument("Text measurements");
  const rectReads = vi.fn();
  const styleWrites = vi.fn();
  const phases: string[] = [];
  const createElementNS = vi.fn((namespace: string | null, tag: string) => {
    const node = nativeDocument.createElementNS(namespace, tag) as HTMLElement;
    if (tag === "div") {
      const setProperty = node.style.setProperty.bind(node.style);
      vi.spyOn(node.style, "setProperty").mockImplementation((...args) => {
        styleWrites(...args);
        phases.push("write");
        setProperty(...args);
      });
    }
    if (tag === "div" || tag === "span")
      vi.spyOn(node, "getBoundingClientRect").mockImplementation(() => {
        rectReads(tag);
        phases.push("read");
        const probe = tag === "span" ? node.parentElement! : node;
        const metrics = nativeLine(
          probe.style.font,
          Number.parseFloat(probe.style.fontSize),
          probe.style.lineHeight,
        );
        return new DOMRect(
          0,
          tag === "span" ? metrics.ascent : 0,
          0,
          tag === "span" ? 0 : metrics.lineHeight,
        );
      });
    return node;
  });
  const createTextNode = vi.fn((text: string) => nativeDocument.createTextNode(text));
  const ownerDocument = {
    createElement,
    createElementNS,
    createTextNode,
    createDocumentFragment: () => nativeDocument.createDocumentFragment(),
    head: nativeDocument.head,
    body: nativeDocument.body,
  } as unknown as Document;
  return {
    context,
    canvas,
    createElement,
    createElementNS,
    createTextNode,
    rectReads,
    styleWrites,
    phases,
    nativeDocument,
    measure: new CanvasTextMeasurer(ownerDocument, resolveFontResourceId, fontResourceBoundaries),
  };
}
