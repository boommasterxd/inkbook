let nextImageScope = 0;

/** Local SVG fragment lookup shares the host document; every presentation gets its own IDs. */
export function createImageReferenceScope(): (element: Element) => void {
  const prefix = `inkbook-raster-${++nextImageScope}-`;
  return (element) => {
    const id = element.getAttribute("id");
    if (id !== null && isPresentationReference(id)) element.setAttribute("id", prefix + id);
    const href = element.getAttribute("href");
    if (href?.startsWith("#") === true && isPresentationReference(href.slice(1)))
      element.setAttribute("href", `#${prefix}${href.slice(1)}`);
    for (const name of ["fill", "stroke", "filter"]) {
      const value = element.getAttribute(name);
      if (value?.startsWith("url(#inkbook-auto-") === true && value.endsWith(")"))
        element.setAttribute(name, `url(#${prefix}${value.slice(5, -1)})`);
    }
  };
}

function isPresentationReference(id: string): boolean {
  return id.startsWith("inkbook-image-") || id === "inkbook-auto" || id.startsWith("inkbook-auto-");
}
