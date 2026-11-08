import { vi } from "vitest";
import { sys } from "typescript";
import {
  prepareExportCutsSteps,
  type ExportInterval,
} from "../../../src/domain/export/export-pagination";
import { StaticExportPagination } from "../../../src/obsidian/embeds/export/print-pagination";
import {
  createExportPage,
  retainExportDrawing,
  type ExportDrawing,
} from "../../../src/obsidian/embeds/export/export-pages";
import { createStaticExportSvg } from "../../../src/obsidian/embeds/export/static-export-svg";
import { exportDescriptor } from "./markdown-export";
import { immediateWorkScheduler } from "./immediate-work-scheduler";

interface PrintLayoutRead {
  readonly kind: "pages" | "bounds" | "style";
  readonly references: number;
  readonly pieces: number;
}

/** Models native print-only CSS sizing before the first fragmented layout is read. */
function mockNativePrintRoot(root: HTMLElement, scale: number) {
  Object.assign(root.style, {
    boxSizing: "border-box",
    transform: "none",
    zoom: "1",
    writingMode: "horizontal-tb",
  });
  const originalLimit = 2000;
  root.style.setProperty("max-inline-size", `${String(originalLimit)}px`, "important");
  const viewport = 720 / scale;
  const css = window.CSS;
  vi.spyOn(css, "supports").mockReturnValue(true);
  // Happy DOM returns a new CSS namespace object on each getter access.
  vi.spyOn(window, "CSS", "get").mockReturnValue(css);
  const rootBounds = vi.spyOn(root, "getBoundingClientRect").mockImplementation(() => {
    const printing = window.matchMedia("print").matches;
    const cap =
      printing && root.classList.contains("inkbook-native-pdf-export")
        ? Math.ceil((viewport + 1) * scale)
        : originalLimit;
    return DOMRect.fromRect({
      width: Math.min(printing ? viewport + 1 : 1024, originalLimit, cap),
    });
  });
  return { rootBounds, viewport };
}

interface PrintPaginationFixtureOptions {
  readonly height?: number;
  readonly width?: number;
  readonly top?: number;
  readonly occurrences?: number;
  readonly paths?: number;
  readonly nativeScale?: number;
  readonly withoutCuts?: boolean;
  readonly deferStart?: boolean;
  readonly hostMargin?: number;
  readonly preparedDrawing?: {
    readonly svg: SVGSVGElement;
    readonly drawing: ExportDrawing;
    readonly intervals: readonly ExportInterval[];
  };
}

/** Native MQL events with controlled print rectangles, not simulated CPU time. */
export async function printPaginationFixture(options: PrintPaginationFixtureOptions = {}) {
  const height = options.height ?? 1800;
  const root = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  document.body.append(root);
  const stylesheet = document.createElementNS("http://www.w3.org/1999/xhtml", "style");
  stylesheet.textContent = [
    ".inkbook-static-export { border-top-left-radius: 10px; }",
    `.inkbook-print-fixture-host { margin-block-start: ${String(options.hostMargin ?? 0)}px; }`,
    sys.readFile(sys.resolvePath("src/obsidian/styles/export.css")) ?? "",
  ].join("\n");
  root.append(stylesheet);
  const { svg, drawing } =
    options.preparedDrawing ?? (await preparePrintDrawing(height, options.paths ?? 1));
  const preparation = prepareExportCutsSteps(
    options.preparedDrawing?.intervals ??
      Array.from({ length: options.paths ?? 1 }, () => ({ minY: 450, maxY: 490 })),
  );
  let step = preparation.next();
  while (!step.done) step = preparation.next();
  const cuts = step.value;
  const controller = new StaticExportPagination(
    root,
    options.nativeScale === undefined
      ? undefined
      : { scale: options.nativeScale, pageSize: "A4", landscape: false, margin: "0" },
  );
  const { measure, ...layout } = observePrintLayout(
    root,
    (options.top ?? 500) + height * (options.occurrences ?? 1) + 200,
    options.width ?? 1000,
  );
  const hosts: HTMLElement[] = [];
  const containers = Array.from({ length: options.occurrences ?? 1 }, (_, index) => {
    const container = createExportPage(document, drawing, { description: "Diagram" });
    if (index === 0) container.prepend(svg);
    const host =
      options.hostMargin === undefined
        ? undefined
        : document.createElementNS("http://www.w3.org/1999/xhtml", "p");
    if (host === undefined) root.append(container);
    else {
      host.className = "inkbook-print-fixture-host";
      host.setAttribute("data-inkbook-export", "");
      host.append(container);
      root.append(host);
      hosts.push(host);
    }
    controller.register({
      ...(host === undefined ? {} : { host }),
      container,
      drawing,
      cuts: options.withoutCuts ? undefined : cuts,
      options: { description: "Diagram" },
    });
    measure(container, (options.top ?? 500) + height * index, height);
    return container;
  });
  const media = window.matchMedia("print");
  const matches = vi.spyOn(media, "matches", "get").mockReturnValue(false);
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) =>
    query === "print" ? media : matchMedia(query),
  );
  const remove = vi.spyOn(media, "removeEventListener");
  const removeWindow = vi.spyOn(window, "removeEventListener");
  const nativeRoot =
    options.nativeScale === undefined ? undefined : mockNativePrintRoot(root, options.nativeScale);
  if (!options.deferStart) controller.start();
  return {
    root,
    controller,
    containers,
    hosts,
    drawing,
    svg,
    ...layout,
    remove,
    removeWindow,
    nativeRoot,
    print: (value: boolean, beforeMediaChange?: () => void) => {
      matches.mockReturnValue(value);
      beforeMediaChange?.();
      media.dispatchEvent(new MediaQueryListEvent("change", { matches: value, media: "print" }));
    },
  };
}

async function preparePrintDrawing(height: number, paths: number) {
  const source = exportDescriptor(
    '<path d="M10 451L30 489" stroke="#102030FF" stroke-width="2"/>'.repeat(paths),
  );
  const svg = await createStaticExportSvg(
    document,
    { ...source, safeSvg: source.safeSvg.replace("2048.6 5200", `1000 ${height}`) },
    { signal: new AbortController().signal, workScheduler: immediateWorkScheduler() },
  );
  if (svg === undefined) throw new Error("Missing print drawing.");
  return { svg, drawing: retainExportDrawing(svg) };
}

function observePrintLayout(root: HTMLElement, height: number, width: number) {
  const layoutReads: PrintLayoutRead[] = [];
  const observe = (kind: PrintLayoutRead["kind"]) => {
    layoutReads.push({
      kind,
      references: root.querySelectorAll("svg[role='img'] use").length,
      pieces: root.querySelectorAll(".inkbook-export-piece").length,
    });
  };
  const measuredBounds: Array<{ readonly mock: { readonly calls: readonly unknown[] } }> = [];
  const pages = vi.spyOn(root, "getClientRects").mockImplementation(() => {
    observe("pages");
    return printRectangles(height);
  });
  const computedStyle = window.getComputedStyle.bind(window);
  const styles = vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    observe("style");
    return computedStyle(element);
  });
  return {
    layoutReads,
    measuredBounds,
    pages,
    styles,
    measure: (container: HTMLElement, top: number, drawingHeight: number) => {
      const media = container.querySelector<HTMLElement>(".inkbook-export-pages");
      if (media === null) throw new Error("Missing print media.");
      for (const [element, y] of [
        [container, top],
        [media, 0],
      ] as const) {
        measuredBounds.push(
          vi.spyOn(element, "getBoundingClientRect").mockImplementation(() => {
            observe("bounds");
            return DOMRect.fromRect({ y, width, height: drawingHeight });
          }),
        );
      }
    },
  };
}

function printRectangles(height: number): DOMRectList {
  const fragments = Array.from({ length: Math.ceil(height / 1000) }, (_, index) =>
    DOMRect.fromRect({
      y: index * 1000,
      width: 1000,
      height: Math.min(1000, height - index * 1000),
    }),
  );
  return Object.assign(fragments, { item: (index: number) => fragments[index] ?? null });
}
