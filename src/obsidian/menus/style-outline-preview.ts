import { outlineDashPattern } from "../../domain/geometry/element-path";

export function createOutlineStylePreview(ownerDocument: Document, value: string): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const width = 2;
  const dash = outlineDashPattern(
    value === "dashed" || value === "dotted" ? value : "solid",
    width,
  );
  const svg = ownerDocument.createElementNS(namespace, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("viewBox", "0 0 28 8");
  const path = ownerDocument.createElementNS(namespace, "path");
  path.setAttribute("d", "M 2 4 H 26");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", String(width));
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  if (dash !== null) path.setAttribute("stroke-dasharray", dash.join(" "));
  svg.append(path);
  return svg;
}
