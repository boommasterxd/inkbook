import type { InkSnapshotV1 } from "../../domain/schema/public";
import { serializeSvgEnvelope } from "../../persistence/documents/svg-envelope";
import { DOCUMENT_PALETTE } from "../../persistence/documents/svg-theme";

const SCHEME_TEST_TIMEOUT_MS = 1_000;
const SCHEME_TEST_HEIGHT = 148.6;
const SCHEME_TEST_SNAPSHOT: InkSnapshotV1 = {
  elements: [],
  format: "inkbook",
  page: {
    activeBufferLines: 1,
    background: { type: "none" },
    innerWidth: 2000,
    lockedBufferLines: 1,
    margin: 24.3,
    writingLineHeight: 100,
  },
  revision: 0,
  version: 1,
};

export const LOCKED_PREVIEW_SCHEME_TEST_SVG = serializeSvgEnvelope(
  SCHEME_TEST_SNAPSHOT,
  SCHEME_TEST_HEIGHT,
  {
    background: [
      '<path class="inkbook-theme-page" d="M 0 0 L 2048.6 0 L 2048.6 148.6 L 0 148.6 Z" fill="#F6F6F6FF"/>',
    ],
    content: [],
    highlights: [],
  },
);

interface SchemeCapabilityWindow extends Window {
  readonly Blob: typeof Blob;
  readonly URL: {
    createObjectURL(object: Blob): string;
    revokeObjectURL(url: string): void;
  };
}

export interface LockedPreviewSchemeCapabilityCheck {
  readonly result: Promise<boolean>;
  dispose(): void;
}

export interface LockedPreviewSchemeCapability {
  supportsContextRepaint(owningWindow: Window): LockedPreviewSchemeCapabilityCheck;
}

interface CapabilityRun {
  consumers: number;
  readonly probe: SchemeCapabilityProbe;
  settled: boolean;
}

export class BrowserLockedPreviewSchemeCapability implements LockedPreviewSchemeCapability {
  readonly #runs = new WeakMap<Window, CapabilityRun>();

  public supportsContextRepaint(owningWindow: Window): LockedPreviewSchemeCapabilityCheck {
    const run = this.#runs.get(owningWindow) ?? this.#start(owningWindow);
    run.consumers += 1;
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        run.consumers -= 1;
        if (run.consumers === 0 && !run.settled) {
          if (this.#runs.get(owningWindow) === run) this.#runs.delete(owningWindow);
          run.probe.cancel();
        }
      },
      result: run.probe.result,
    };
  }

  #start(owningWindow: Window): CapabilityRun {
    const run: CapabilityRun = {
      consumers: 0,
      probe: new SchemeCapabilityProbe(owningWindow),
      settled: false,
    };
    this.#runs.set(owningWindow, run);
    void run.probe.result.then(() => {
      run.settled = true;
    });
    return run;
  }
}

export const browserLockedPreviewSchemeCapability = new BrowserLockedPreviewSchemeCapability();

class SchemeCapabilityProbe {
  readonly #browserWindow: SchemeCapabilityWindow | undefined;
  readonly #frames = new Set<number>();
  #canvas: HTMLCanvasElement | undefined;
  #complete: (result: boolean) => void = () => undefined;
  #context: CanvasRenderingContext2D | undefined;
  #image: HTMLImageElement | undefined;
  #settled = false;
  #timeout: number | undefined;
  #url: string | undefined;
  readonly result: Promise<boolean>;

  constructor(readonly owningWindow: Window) {
    this.#browserWindow = schemeCapabilityWindow(owningWindow);
    this.result = new Promise<boolean>((resolve) => {
      this.#complete = resolve;
    });
    this.#start();
  }

  cancel(): void {
    this.#finish(false);
  }

  #start(): void {
    const browserWindow = this.#browserWindow;
    const ownerDocument = this.owningWindow.document;
    if (
      browserWindow === undefined ||
      ownerDocument.body === null ||
      typeof this.owningWindow.requestAnimationFrame !== "function" ||
      typeof this.owningWindow.cancelAnimationFrame !== "function"
    ) {
      this.#finish(false);
      return;
    }
    try {
      this.#image = ownerDocument.body.createEl("img");
      this.#canvas = ownerDocument.body.createEl("canvas");
      prepareProbeElement(this.#image);
      prepareProbeElement(this.#canvas);
      this.#image.setCssProps({ colorScheme: "light" });
      this.#image.alt = "";
      this.#image.width = 2;
      this.#image.height = 2;
      this.#canvas.width = 2;
      this.#canvas.height = 2;
      this.#context = this.#canvas.getContext("2d", { willReadFrequently: true }) ?? undefined;
      if (this.#context === undefined) {
        this.#finish(false);
        return;
      }
      this.#url = browserWindow.URL.createObjectURL(
        new browserWindow.Blob([LOCKED_PREVIEW_SCHEME_TEST_SVG], { type: "image/svg+xml" }),
      );
      this.#image.onload = () => this.#imageLoaded();
      this.#image.onerror = () => this.#finish(false);
      this.#timeout = this.owningWindow.setTimeout(
        () => this.#finish(false),
        SCHEME_TEST_TIMEOUT_MS,
      );
      this.#image.src = this.#url;
    } catch {
      this.#finish(false);
    }
  }

  #imageLoaded(): void {
    if (this.#settled) return;
    this.#clearLoadWait();
    this.#afterPaint(() => {
      const light = this.#readPixel();
      if (light === undefined || this.#image === undefined) {
        this.#finish(false);
        return;
      }
      this.#image.setCssProps({ colorScheme: "dark" });
      this.#afterPaint(() => {
        const dark = this.#readPixel();
        this.#finish(
          dark !== undefined &&
            pixelMatches(light, DOCUMENT_PALETTE.light.page) &&
            pixelMatches(dark, DOCUMENT_PALETTE.dark.page),
        );
      });
    });
  }

  #afterPaint(callback: () => void): void {
    if (this.#settled) return;
    const first = this.owningWindow.requestAnimationFrame(() => {
      this.#frames.delete(first);
      if (this.#settled) return;
      const second = this.owningWindow.requestAnimationFrame(() => {
        this.#frames.delete(second);
        if (!this.#settled) callback();
      });
      this.#frames.add(second);
    });
    this.#frames.add(first);
  }

  #readPixel(): Uint8ClampedArray | undefined {
    const context = this.#context;
    const image = this.#image;
    if (context === undefined || image === undefined) return undefined;
    context.clearRect(0, 0, 2, 2);
    context.drawImage(image, 0, 0, 2, 2);
    return context.getImageData(0, 0, 1, 1).data;
  }

  #finish(result: boolean): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#clearLoadWait();
    for (const frame of this.#frames) this.owningWindow.cancelAnimationFrame(frame);
    this.#frames.clear();
    this.#image?.remove();
    this.#canvas?.remove();
    if (this.#url !== undefined) this.#browserWindow?.URL.revokeObjectURL(this.#url);
    this.#image = undefined;
    this.#canvas = undefined;
    this.#context = undefined;
    this.#url = undefined;
    const complete = this.#complete;
    this.#complete = () => undefined;
    complete(result);
  }

  #clearLoadWait(): void {
    if (this.#timeout !== undefined) this.owningWindow.clearTimeout(this.#timeout);
    this.#timeout = undefined;
    if (this.#image !== undefined) {
      this.#image.onload = null;
      this.#image.onerror = null;
    }
  }
}

function prepareProbeElement(element: HTMLElement): void {
  element.setCssProps({
    inset: "auto auto auto -10000px",
    pointerEvents: "none",
    position: "fixed",
  });
}

function schemeCapabilityWindow(owningWindow: Window): SchemeCapabilityWindow | undefined {
  const candidate = owningWindow as Partial<SchemeCapabilityWindow>;
  const url = candidate.URL;
  return typeof candidate.Blob === "function" &&
    url !== undefined &&
    typeof url.createObjectURL === "function" &&
    typeof url.revokeObjectURL === "function"
    ? (candidate as SchemeCapabilityWindow)
    : undefined;
}

function pixelMatches(pixel: Uint8ClampedArray, rgba: string): boolean {
  return [0, 1, 2].every(
    (index) => pixel[index] === Number.parseInt(rgba.slice(1 + index * 2, 3 + index * 2), 16),
  );
}
