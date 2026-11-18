import type { InkElementV1, InkClipboardV1 } from "../../domain/schema/public";
import type { ClipboardResult } from "./types";
import {
  assertImageResourcesSteps,
  assertImageBindingsSteps,
} from "../../domain/schema/image-validation";
import { validateImageResourceSteps } from "../images/image-resources";
import { assertFontResourcesSteps } from "../../domain/schema/font-resource-validation";
import { usedFontResourcesSteps } from "../fonts/used-font-resources";
import { validateFontResourceSteps } from "../fonts/font-resources";

export interface ClipboardResourceSelection {
  readonly selectedFonts?: InkClipboardV1["fontResources"];
  readonly selectedImages?: InkClipboardV1["imageResources"];
}

const invalidResources = (message: string): ClipboardResult<never> => ({
  ok: false,
  error: { code: "invalid-schema", message },
});

export function* validateClipboardResourcesSteps(
  value: Record<string, unknown>,
  elements: readonly InkElementV1[],
  runtime: ClipboardResourceSelection,
): Generator<boolean | void, ClipboardResult<void>> {
  try {
    const hasImages = elements.some((element) => element.kind === "image");
    if ((value.version as number) < 3 && (hasImages || value.imageResources !== undefined))
      return invalidResources("Images and image resources require clipboard version 3.");
    if (
      (hasImages || value.imageResources !== undefined) &&
      (value.imageResources === undefined || value.imageResources !== runtime.selectedImages)
    )
      yield* validateClipboardImagesSteps(value, elements);
    const hasText = elements.some((element) => element.kind === "text");
    if (value.version === 1 && (hasText || value.fontResources !== undefined)) {
      return invalidResources("Text and font resources require clipboard version 2.");
    }
    if (
      (hasText || value.fontResources !== undefined) &&
      (value.fontResources === undefined || value.fontResources !== runtime.selectedFonts)
    )
      yield* validateClipboardFontsSteps(value, elements);
  } catch {
    return invalidResources(
      "Clipboard resources are invalid or a required resource is unavailable.",
    );
  }
  return { ok: true, value: undefined };
}

function* validateClipboardImagesSteps(
  value: Record<string, unknown>,
  elements: readonly InkElementV1[],
) {
  if (value.imageResources !== undefined) {
    yield* assertImageResourcesSteps(value.imageResources, "$.imageResources");
    for (const resource of value.imageResources as NonNullable<InkClipboardV1["imageResources"]>) {
      for (const _step of validateImageResourceSteps(resource)) {
        void _step;
        yield true;
      }
    }
  }
  yield* assertImageBindingsSteps(
    elements,
    (value.imageResources ?? []) as NonNullable<InkClipboardV1["imageResources"]>,
  );
}

function* validateClipboardFontsSteps(
  value: Record<string, unknown>,
  elements: readonly InkElementV1[],
) {
  if (value.fontResources !== undefined) {
    const fonts = assertFontResourcesSteps(value.fontResources, "$.fontResources");
    for (let step = fonts.next(); !step.done; step = fonts.next()) yield true;
    for (const resource of value.fontResources as NonNullable<InkClipboardV1["fontResources"]>) {
      const verified = validateFontResourceSteps(resource);
      for (let step = verified.next(); !step.done; step = verified.next()) yield true;
    }
  }
  yield* usedFontResourcesSteps(
    elements,
    (value.fontResources ?? []) as NonNullable<InkClipboardV1["fontResources"]>,
  );
}
