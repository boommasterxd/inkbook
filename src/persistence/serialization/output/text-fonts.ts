import type { FontResourceV2, InkElementV1, InkSnapshotV1 } from "../../../domain/schema/public";
import { fontCssFamily, validateFontResourceSteps } from "../../fonts/font-resources";
import { usedFontResourcesSteps } from "../../fonts/used-font-resources";
import { assertFontResourcesSteps } from "../../../domain/schema/font-resource-validation";
import { codecFailure } from "../codec-failure";
import type { DocumentCodecResult } from "../types";
import { fontResourceCssFamily } from "../../../domain/text/font-family";

export function usedFontResources(
  elements: readonly InkElementV1[],
  resources: readonly FontResourceV2[],
): FontResourceV2[] {
  const steps = usedFontResourcesSteps(elements, resources);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export function snapshotTextResources(snapshot: InkSnapshotV1): {
  fontResources?: FontResourceV2[];
} {
  if (snapshot.version === 1) return {};
  const resources = usedFontResources(snapshot.elements, snapshot.fontResources ?? []);
  return resources.length === 0 ? {} : { fontResources: resources.map(canonicalFontResource) };
}

export function canonicalFontResource(resource: FontResourceV2): FontResourceV2 {
  return {
    id: resource.id,
    family: resource.family,
    weight: resource.weight,
    ...(resource.weightRange === undefined
      ? {}
      : { weightRange: [...resource.weightRange] as [number, number] }),
    style: resource.style,
    mimeType: resource.mimeType,
    data: resource.data,
    ...(resource.license === undefined ? {} : { license: resource.license }),
  };
}

export function serializeFontStylesheet(
  resources: readonly FontResourceV2[],
  legacyFamilyAliases = false,
): string {
  return [...fontStylesheetFragments(resources, legacyFamilyAliases)].join("");
}

export function* fontStylesheetFragments(
  resources: readonly FontResourceV2[],
  legacyFamilyAliases = false,
): Iterable<string> {
  const formats = {
    "font/woff2": "woff2",
    "font/woff": "woff",
    "font/ttf": "truetype",
    "font/otf": "opentype",
  };
  for (const resource of resources) {
    const weight = resource.weightRange?.join(" ") ?? resource.weight;
    const family = legacyFamilyAliases
      ? fontCssFamily(resource.family)
      : fontResourceCssFamily(resource.id);
    yield `@font-face{font-family:"${family}";font-style:${resource.style};font-weight:${weight};src:url("data:${resource.mimeType};base64,`;
    for (let start = 0; start < resource.data.length; start += 64 * 1024)
      yield resource.data.slice(start, start + 64 * 1024);
    yield `") format("${formats[resource.mimeType]}")}`;
  }
}

export function* matchesFontStylesheetSteps(
  input: string,
  resources: readonly FontResourceV2[],
  legacyFamilyAliases = false,
): Generator<void, boolean> {
  let offset = 0;
  for (const fragment of fontStylesheetFragments(resources, legacyFamilyAliases)) {
    if (!input.startsWith(fragment, offset)) return false;
    offset += fragment.length;
    yield;
  }
  return offset === input.length;
}

export function fontStylesheetMarkup(resources: readonly FontResourceV2[]): string {
  return [...fontStylesheetMarkupFragments(resources)].join("");
}

export function* fontStylesheetMarkupFragments(
  resources: readonly FontResourceV2[],
): Iterable<string> {
  if (resources.length === 0) return;
  yield '<style id="inkbook-fonts">';
  yield* fontStylesheetFragments(resources);
  yield "</style>";
}

/** Recheck retained text references only when the registry changes. */
export function* deltaTextElements(
  current: ReadonlyMap<string, InkElementV1>,
  changed: ReadonlyMap<string, InkElementV1>,
  removed: ReadonlySet<string>,
  registryChanged: boolean,
): Iterable<InkElementV1> {
  if (registryChanged) {
    for (const element of current.values()) {
      if (element.kind === "text" && !changed.has(element.id) && !removed.has(element.id))
        yield element;
    }
  }
  yield* changed.values();
}

export function retainsFontFaces(
  current: readonly FontResourceV2[],
  next: readonly FontResourceV2[],
): boolean {
  return current.every((face) =>
    next.some(
      (candidate) =>
        face.id === candidate.id &&
        face.family === candidate.family &&
        face.style === candidate.style &&
        face.weight === candidate.weight &&
        face.weightRange?.[0] === candidate.weightRange?.[0] &&
        face.weightRange?.[1] === candidate.weightRange?.[1],
    ),
  );
}

export function* prepareDeltaFontResourcesSteps(
  current: FontResourceV2[],
  proposed: readonly FontResourceV2[] | undefined,
  signal?: AbortSignal,
): Generator<void, DocumentCodecResult<FontResourceV2[]>> {
  if (proposed === undefined) return { ok: true, value: current };
  try {
    yield* assertFontResourcesSteps(proposed, "$.fontResources");
    for (const resource of proposed) {
      fontCssFamily(resource.family);
      if (
        !current.some((previous) => previous.id === resource.id && previous.data === resource.data)
      )
        yield* validateFontResourceSteps(resource, signal);
    }
    return { ok: true, value: proposed.map(canonicalFontResource) };
  } catch {
    signal?.throwIfAborted();
    return codecFailure("invalid-delta", "Invalid document font resources.");
  }
}
