import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";
import { inspectTrustedSvgOutput } from "../../persistence/scheduling/trusted-svg-output";

const METADATA_OPEN = "<metadata";
const METADATA_CLOSE = "</metadata>";

export interface LoadedPreviewSvg {
  readonly aspectRatio: number;
  readonly safeSvg: string;
}

export async function validatePreviewSvg(source: string | Uint8Array): Promise<string | null> {
  try {
    const trusted = await inspectTrustedSvgOutput(source, undefined, {
      versionPolicy: "editable",
    });
    return trusted.content;
  } catch {
    return null;
  }
}

export async function loadValidatedPreviewSvg(
  source: string,
  owningWindow: Window,
): Promise<LoadedPreviewSvg> {
  const response = await owningWindow.fetch(source);
  if (!response.ok) throw new Error("The Inkbook preview source could not be loaded.");
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > FILE_SCHEMA_LIMITS.totalInputBytes) {
    throw new Error("The Inkbook preview source exceeds the file limit.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > FILE_SCHEMA_LIMITS.totalInputBytes) {
    throw new Error("The Inkbook preview source exceeds the file limit.");
  }
  let trusted;
  try {
    trusted = await inspectTrustedSvgOutput(bytes, undefined, { versionPolicy: "editable" });
  } catch {
    throw new Error("The Inkbook preview source is not safe SVG.");
  }
  return { aspectRatio: 2_048.6 / trusted.lockedHeight, safeSvg: trusted.content };
}

export function createPreviewSvg(ownerDocument: Document, safeSvg: string): SVGSVGElement {
  const owningWindow = ownerDocument.defaultView;
  if (owningWindow === null) throw new Error("The Inkbook preview has no owning window.");
  const parser = new owningWindow.DOMParser();
  const parsed = parser.parseFromString(withoutMetadata(safeSvg), "image/svg+xml");
  const source = parsed.documentElement;
  if (source.namespaceURI !== "http://www.w3.org/2000/svg" || source.localName !== "svg") {
    throw new Error("The validated Inkbook preview did not produce an SVG root.");
  }
  source.getElementsByTagName("style").item(0)?.remove();
  const svg = ownerDocument.importNode(source, true) as unknown as SVGSVGElement;
  svg.classList.add("inkbook-locked-preview-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("height", "100%");
  svg.setAttribute("preserveAspectRatio", "xMidYMin meet");
  svg.setAttribute("width", "100%");
  return svg;
}

function withoutMetadata(safeSvg: string): string {
  const start = safeSvg.indexOf(METADATA_OPEN);
  const closing = safeSvg.indexOf(METADATA_CLOSE, start);
  if (start < 0 || closing < 0) {
    throw new Error("The validated Inkbook preview has no metadata envelope.");
  }
  return `${safeSvg.slice(0, start)}${safeSvg.slice(closing + METADATA_CLOSE.length)}`;
}
