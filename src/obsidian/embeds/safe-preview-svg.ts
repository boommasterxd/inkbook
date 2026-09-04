import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";
import type { PersistedDocumentIdentity } from "../../editor/session/session-port";
import { inspectTrustedSvgOutput } from "../../persistence/scheduling/trusted-svg-output";

const METADATA_OPEN = "<metadata";
const METADATA_CLOSE = "</metadata>";

export interface LoadedPreviewSvg {
  readonly aspectRatio: number;
  readonly contentIdentity: PreviewContentIdentity;
  readonly safeSvg: string;
}

export type PreviewContentIdentity = PersistedDocumentIdentity;

export function samePreviewContentIdentity(
  left: PreviewContentIdentity,
  right: PreviewContentIdentity,
): boolean {
  return left.revision === right.revision && left.outputHash === right.outputHash;
}

export async function inspectPreviewSvg(
  source: string | Uint8Array,
): Promise<LoadedPreviewSvg | null> {
  try {
    const trusted = await inspectTrustedSvgOutput(source, undefined, {
      versionPolicy: "editable",
    });
    return {
      aspectRatio: 2_048.6 / trusted.lockedHeight,
      contentIdentity: { outputHash: trusted.outputHash, revision: trusted.revision },
      safeSvg: trusted.content,
    };
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
  const trusted = await inspectPreviewSvg(bytes);
  if (trusted === null) {
    throw new Error("The Inkbook preview source is not safe SVG.");
  }
  return trusted;
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
