import { assertImageResourcesSteps } from "../../../domain/schema/image-validation";
import type {
  FontResourceV2,
  ImageResourceV3,
  InkElementV1,
  InkSnapshotV1,
} from "../../../domain/schema/public";
import { validateFontResourceSteps } from "../../fonts/font-resources";
import { usedFontResourcesSteps } from "../../fonts/used-font-resources";
import { canonicalImageResource, validateImageResourceSteps } from "../../images/image-resources";
import { usedImageResourcesSteps } from "../../images/used-image-resources";
import { codecFailure } from "../codec-failure";
import type { DocumentCodecResult } from "../types";
import type {
  DocumentSerializationDelta,
  PreparedDelta,
} from "./incremental-document-serializer-types";
import { prepareDeltaFontResourcesSteps, retainsFontFaces } from "./text-fonts";

export function* validateSnapshotResourcesSteps(
  snapshot: InkSnapshotV1,
): Generator<void, ImageResourceV3[] | null> {
  try {
    const images = (snapshot.imageResources ?? []).map(canonicalImageResource);
    for (const resource of images) yield* validateImageResourceSteps(resource);
    for (const resource of snapshot.fontResources ?? []) yield* validateFontResourceSteps(resource);
    const text = [];
    for (let index = 0; index < snapshot.elements.length; index += 1) {
      const element = snapshot.elements[index]!;
      if (element.kind === "text") text.push(element);
      if ((index + 1) % 256 === 0) yield;
    }
    yield* usedFontResourcesSteps(text, snapshot.fontResources ?? []);
    return images;
  } catch {
    return null;
  }
}

interface ResourceDeltaSource {
  readonly fonts: FontResourceV2[];
  readonly images: ImageResourceV3[];
  readonly elements: ReadonlyMap<string, InkElementV1>;
  readonly delta: DocumentSerializationDelta;
  readonly prepared: PreparedDelta;
}

export function* prepareSerializationDeltaResourcesSteps(
  source: ResourceDeltaSource,
  signal?: AbortSignal,
): Generator<void, DocumentCodecResult<{ fonts: FontResourceV2[]; images: ImageResourceV3[] }>> {
  const { delta } = source;
  const fonts = yield* prepareDeltaFontResourcesSteps(source.fonts, delta.fontResources, signal);
  if (!fonts.ok) return fonts;
  const images = yield* prepareImageRegistrySteps(source.images, delta.imageResources, signal);
  if (!images.ok) return images;
  try {
    const references = yield* deltaResourceElementsSteps(
      source,
      !retainsFontFaces(source.fonts, fonts.value),
      images.value.retained,
    );
    yield* usedFontResourcesSteps(references.text, fonts.value);
    yield* usedImageResourcesSteps(references.images, images.value.resources);
  } catch {
    signal?.throwIfAborted();
    return codecFailure("invalid-delta", "Document image or font resources are invalid.");
  }
  return { ok: true, value: { fonts: fonts.value, images: images.value.resources } };
}

function* prepareImageRegistrySteps(
  current: ImageResourceV3[],
  proposed: readonly ImageResourceV3[] | undefined,
  signal?: AbortSignal,
): Generator<
  void,
  DocumentCodecResult<{
    resources: ImageResourceV3[];
    retained?: ReadonlyMap<string, ImageResourceV3>;
  }>
> {
  if (proposed === undefined) return { ok: true, value: { resources: current } };
  try {
    const previous = new Map(current.map((resource) => [resource.id, resource]));
    const retained = yield* assertImageResourcesSteps(proposed, "$.imageResources", previous);
    const resources = proposed.map(
      (resource) => retained.get(resource.id) ?? canonicalImageResource(resource),
    );
    for (const resource of resources) {
      if (retained.get(resource.id) !== resource)
        yield* validateImageResourceSteps(resource, signal);
    }
    return { ok: true, value: { resources, retained } };
  } catch {
    signal?.throwIfAborted();
    return codecFailure("invalid-delta", "Invalid image resource registry.");
  }
}

/** Append-only changes preserve all retained bindings. Other changes visit records cooperatively. */
function* deltaResourceElementsSteps(
  source: ResourceDeltaSource,
  fontsChanged: boolean,
  retainedImages?: ReadonlyMap<string, ImageResourceV3>,
): Generator<void, { images: InkElementV1[]; text: InkElementV1[] }> {
  const { changed, removed } = source.prepared;
  const images = yield* retainedImageBindingsSteps(source, retainedImages);
  const text: InkElementV1[] = [];
  let visited = 0;
  if (fontsChanged) {
    for (const element of source.elements.values()) {
      if (element.kind === "text" && !changed.has(element.id) && !removed.has(element.id))
        text.push(element);
      if (++visited % 256 === 0) yield;
    }
  }
  for (const element of changed.values()) {
    if (element.kind === "text") text.push(element);
    if (element.kind === "image") images.push(element);
    if (++visited % 256 === 0) yield;
  }
  return { images, text };
}

function* retainedImageBindingsSteps(
  source: ResourceDeltaSource,
  retained: ReadonlyMap<string, ImageResourceV3> | undefined,
): Generator<void, InkElementV1[]> {
  if (retained === undefined || source.images.every(({ id }) => retained.has(id))) return [];
  const bindings: InkElementV1[] = [];
  const { changed, orders } = source.prepared;
  for (let index = 0; index < orders.image.length; index += 1) {
    const id = orders.image[index]!;
    const element = source.elements.get(id);
    if (element?.kind === "image" && !changed.has(id) && !retained.has(element.assetId))
      bindings.push(element);
    if ((index + 1) % 256 === 0) yield;
  }
  return bindings;
}
