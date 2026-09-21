import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";
import type { PersistedDocumentIdentity } from "../../editor/session/session-port";
import { inspectTrustedSvgOutput } from "../../persistence/scheduling/trusted-svg-output";

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
  waitForBackground?: () => Promise<void>,
  signal?: AbortSignal,
  sliceBudgetMs?: () => number,
): Promise<LoadedPreviewSvg | null> {
  try {
    const trusted = await inspectTrustedSvgOutput(source, undefined, {
      ...(signal === undefined ? {} : { signal }),
      versionPolicy: "editable",
      ...(sliceBudgetMs === undefined ? {} : { sliceBudgetMs }),
      ...(waitForBackground === undefined ? {} : { waitForBackground }),
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
  waitForBackground?: () => Promise<void>,
  signal?: AbortSignal,
  sliceBudgetMs?: () => number,
): Promise<LoadedPreviewSvg> {
  const response = await owningWindow.fetch(source, signal === undefined ? undefined : { signal });
  if (!response.ok) throw new Error("The Inkbook preview source could not be loaded.");
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > FILE_SCHEMA_LIMITS.totalInputBytes) {
    throw new Error("The Inkbook preview source exceeds the file limit.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > FILE_SCHEMA_LIMITS.totalInputBytes) {
    throw new Error("The Inkbook preview source exceeds the file limit.");
  }
  const trusted = await inspectPreviewSvg(bytes, waitForBackground, signal, sliceBudgetMs);
  if (trusted === null) {
    throw new Error("The Inkbook preview source is not safe SVG.");
  }
  return trusted;
}

export function configurePreviewSvg(svg: SVGSVGElement): void {
  svg.classList.add("inkbook-locked-preview-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("height", "100%");
  svg.setAttribute("preserveAspectRatio", "xMidYMin meet");
  svg.setAttribute("width", "100%");
}
