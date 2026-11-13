import type { FontLibraryEntryV2 } from "../../domain/settings";
import { fontFacesOverlap } from "../../domain/text/font-face-matching";

export class FontFamilyFaceConflictError extends Error {
  public readonly code = "face-conflict";

  public constructor() {
    super("This family already contains an overlapping face. Choose another family.");
  }
}

/** Equal display names never establish identity; only explicit existing IDs join files. */
export function resolveImportedFontFamily(
  faces: readonly FontLibraryEntryV2[],
  requested: string,
  id: string,
): string {
  if (requested === "upload") return faces.find((face) => face.id === id)?.family ?? `custom-${id}`;
  if (
    !/^custom-[a-f0-9]{64}$/.test(requested) ||
    !faces.some((face) => face.family === requested)
  ) {
    throw new RangeError("The selected font family is unavailable.");
  }
  return requested;
}

export function assertAvailableFamilyFace(
  faces: readonly FontLibraryEntryV2[],
  candidate: Pick<FontLibraryEntryV2, "id" | "family" | "weight" | "style" | "weightRange">,
): void {
  for (const face of faces) {
    if (face.id !== candidate.id && fontFacesOverlap(face, candidate))
      throw new FontFamilyFaceConflictError();
  }
}

/** User-assigned labels stay separate from the stable family identity. */
export function fontLibraryChoices(
  faces: readonly FontLibraryEntryV2[],
): readonly { label: string; value: string }[] {
  const choices = new Map<string, { label: string; value: string }>();
  for (const face of faces) {
    if (!choices.has(face.family))
      choices.set(face.family, {
        label: face.displayName,
        value: face.family,
      });
  }
  return [...choices.values()];
}
