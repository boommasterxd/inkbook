import type { FontResourceV2 } from "../../domain/schema/public";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { matchFontFace, type FontFaceDescriptor } from "../../domain/text/font-face-matching";
import { BUILTIN_FONT_FAMILIES, loadBuiltinFont } from "../../persistence/fonts/builtin-fonts";
import type { FontFaceRequest } from "../../persistence/fonts/font-resources";

export interface FontPreviewSource {
  readonly resources?: () => readonly FontResourceV2[];
  readonly library?: {
    match?(request: FontFaceRequest): (FontFaceDescriptor & { readonly id: string }) | undefined;
    resolve(
      request: FontFaceRequest,
      signal?: AbortSignal,
      scheduler?: WorkScheduler,
    ): Promise<FontResourceV2 | undefined>;
  };
}

/** Read existing resources when possible; preview resolution never writes a document. */
export async function resolveFontPreview(
  family: string,
  scheduler: WorkScheduler,
  source: FontPreviewSource,
  signal: AbortSignal,
): Promise<FontResourceV2 | undefined> {
  signal.throwIfAborted();
  const request: FontFaceRequest = { family, weight: 400, style: "normal" };
  const resources = source.resources?.() ?? [];
  const exact = matchFontFace(resources, request, false);
  if (exact !== undefined) return exact;
  if (BUILTIN_FONT_FAMILIES.some((candidate) => candidate === family)) {
    return loadBuiltinFont(family, 400, "normal", scheduler, signal);
  }
  const metadata = source.library?.match?.(request);
  if (metadata !== undefined) {
    const chosen = matchFontFace([...resources, metadata], request);
    const existing = resources.find((resource) => resource.id === chosen?.id);
    if (existing !== undefined) return existing;
  }
  if (metadata !== undefined || source.library?.match === undefined) {
    const resource = await source.library?.resolve(request, signal, scheduler);
    signal.throwIfAborted();
    if (resource !== undefined) return matchFontFace([...resources, resource], request);
  }
  return matchFontFace(resources, request);
}
