import type { StaticExportFragment } from "../../../src/persistence/export/static-export-fragments";

interface ExportFragmentSource extends StaticExportFragment {
  readonly markup: string;
}

/** Owned static SVG bands with retained path identities, independent of parser validation. */
export function exportFragmentFixture(bands: readonly (readonly ExportFragmentSource[])[]) {
  const parsed = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 30000">${bands
      .map((band) => `<g>${band.map((fragment) => fragment.markup).join("")}</g>`)
      .join("")}</svg>`,
    "image/svg+xml",
  );
  const svg = document.adoptNode(parsed.documentElement) as unknown as SVGSVGElement;
  const paths = [...svg.querySelectorAll("path")];
  const fragments: readonly StaticExportFragment[] = bands.flat().map((fragment) => ({
    minY: fragment.minY,
    maxY: fragment.maxY,
    background: fragment.background,
  }));
  return { svg, paths, fragments };
}

/** Resolve actual page references to their retained painted paths in SVG paint order. */
export function resolveExportPagePaths(svg: SVGSVGElement, page: HTMLElement): Element[] {
  return [...page.querySelectorAll("use")].flatMap((reference) => {
    const id = reference.getAttribute("href");
    const target = id === null ? null : svg.querySelector(id);
    if (target === null) throw new Error("A print page references missing retained geometry.");
    return target.localName === "path" ? [target] : [...target.querySelectorAll("path")];
  });
}
