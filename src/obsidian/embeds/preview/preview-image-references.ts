let nextImageScope = 0;

/** Local SVG fragment lookup shares the host document; every presentation gets its own IDs. */
export function createImageReferenceScope(): (element: Element) => void {
  const prefix = `inkbook-raster-${++nextImageScope}-`;
  return (element) => {
    const id = element.getAttribute("id");
    if (element.localName === "image" && id?.startsWith("inkbook-image-") === true)
      element.setAttribute("id", prefix + id);
    const href = element.getAttribute("href");
    if (element.localName === "use" && href?.startsWith("#inkbook-image-") === true)
      element.setAttribute("href", `#${prefix}${href.slice(1)}`);
  };
}
