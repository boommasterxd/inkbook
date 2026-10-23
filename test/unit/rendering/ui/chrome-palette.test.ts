// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { createChromePalette } from "../../../../src/rendering/ui/chrome-palette";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function mountPalette(color: string) {
  const element = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  document.body.append(element);
  vi.spyOn(window, "getComputedStyle").mockReturnValue({ color } as CSSStyleDeclaration);
  return createChromePalette(element);
}

describe("chrome palette browser boundary", () => {
  it("waits for available theme tokens before opening a native raster context", () => {
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    const palette = mountPalette("");
    try {
      expect(palette.read()).toBeUndefined();
      expect(context).not.toHaveBeenCalled();
    } finally {
      palette.dispose();
    }
  });

  it("reports an unavailable 2D context instead of passing unsupported colors to Motion", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const palette = mountPalette("color(srgb 0 0 0 / 0.067)");
    try {
      expect(() => palette.read()).toThrow("Inkbook chrome requires a 2D color context.");
    } finally {
      palette.dispose();
    }
  });

  it("preserves the browser failure when pixel reads are blocked", () => {
    const error = new DOMException("Pixel access blocked", "SecurityError");
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: () => undefined,
      fillRect: () => undefined,
      fillStyle: "",
      getImageData: () => {
        throw error;
      },
    } as unknown as CanvasRenderingContext2D);
    const palette = mountPalette("color(srgb 0 0 0 / 0.067)");
    try {
      expect(() => palette.read()).toThrow(error);
    } finally {
      palette.dispose();
    }
  });
});
