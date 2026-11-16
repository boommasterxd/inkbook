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

export function* validateSnapshotResourcesSteps(snapshot: InkSnapshotV1): Generator<void, boolean> {
  try {
    for (const resource of snapshot.imageResources ?? [])
      yield* validateImageResourceSteps(resource);
    for (const resource of snapshot.fontResources ?? []) yield* validateFontResourceSteps(resource);
    yield* usedFontResourcesSteps(snapshot.elements, snapshot.fontResources ?? []);
    return true;
  } catch {
    return false;
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
  if (delta.imageResources !== undefined) {
    try {
      yield* assertImageResourcesSteps(delta.imageResources, "$.imageResources");
    } catch {
      return codecFailure("invalid-delta", "Invalid image resource registry.");
    }
  }
  const images =
    delta.imageResources === undefined
      ? source.images
      : delta.imageResources.map(canonicalImageResource);
  try {
    for (const resource of images) yield* validateImageResourceSteps(resource, signal);
    yield* usedFontResourcesSteps(
      deltaResourceElements(source, "text", !retainsFontFaces(source.fonts, fonts.value)),
      fonts.value,
    );
    yield* usedImageResourcesSteps(
      deltaResourceElements(source, "image", delta.imageResources !== undefined),
      images,
    );
  } catch {
    signal?.throwIfAborted();
    return codecFailure("invalid-delta", "Document image or font resources are invalid.");
  }
  return { ok: true, value: { fonts: fonts.value, images } };
}

/** Retained references need checking only when their owning registry changes. */
function* deltaResourceElements(
  source: ResourceDeltaSource,
  kind: "text" | "image",
  registryChanged: boolean,
): Iterable<InkElementV1> {
  const { changed, removed } = source.prepared;
  if (registryChanged) {
    for (const element of source.elements.values()) {
      if (element.kind === kind && !changed.has(element.id) && !removed.has(element.id))
        yield element;
    }
  }
  yield* changed.values();
}
