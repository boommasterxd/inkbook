import { vi } from "vitest";
import type { FontResourceV2, TextElementV2 } from "../../../src/domain/schema/public";
import { textElement } from "../../unit/domain/schema/fixtures";
import { nativeMetrics } from "../rendering/text-measurement-boundary";
import { installFontPreviewHost } from "./native-font-preview";

export function nativeInkText(resource: FontResourceV2, index = 8): TextElementV2 {
  const element = textElement(index);
  element.style.fontFamily = resource.family;
  element.layout.baseFontResourceId = resource.id;
  element.layout.lines[0]!.runs[0]!.fontResourceId = resource.id;
  return element;
}

/** Observes actual native font ownership and canvas measurements at host API boundaries. */
export function installNativeTextInkHost() {
  const fonts = installFontPreviewHost(document);
  let maximumRetainedFaces = 0;
  const context = {
    font: "",
    measureText: vi.fn((text: string) => {
      maximumRetainedFaces = Math.max(maximumRetainedFaces, fonts.retained.size);
      return {
        ...nativeMetrics(text.length * 10, 20, 4),
        actualBoundingBoxLeft: 2,
        actualBoundingBoxRight: 60,
      };
    }),
  };
  const canvases: HTMLCanvasElement[] = [];
  const nativeCanvas = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(function (this: HTMLCanvasElement) {
      canvases.push(this);
      return context as unknown as CanvasRenderingContext2D;
    });
  return {
    ...fonts,
    canvases,
    context,
    maximumRetainedFaces: () => maximumRetainedFaces,
    dispose: () => {
      nativeCanvas.mockRestore();
      fonts.restore();
    },
  };
}
