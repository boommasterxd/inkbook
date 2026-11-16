import { vi } from "vitest";

/** Records the native canvas boundary while using a supplied encoded image fixture. */
export function installImageRasterBoundary(bytes: Uint8Array<ArrayBuffer>) {
  const canvases: HTMLCanvasElement[] = [];
  const contexts: CanvasRenderingContext2D[] = [];
  const draws: { width: number; height: number }[] = [];
  const draw = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    canvases.push(this);
    const context = {
      drawImage: (...args: unknown[]) => {
        draws.push({ width: this.width, height: this.height });
        draw(...args);
      },
    } as unknown as CanvasRenderingContext2D;
    contexts.push(context);
    return context;
  });
  const encode = vi
    .spyOn(HTMLCanvasElement.prototype, "toBlob")
    .mockImplementation((callback) => callback(new Blob([bytes], { type: "image/png" })));
  return { canvases, draw, encode, contexts, draws };
}
