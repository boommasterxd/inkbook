import type { FontLibraryEntryV2 } from "../../domain/settings";
import { fontFacesOverlap } from "../../domain/text/font-face-matching";
import { FONT_LIMITS } from "../../persistence/fonts/font-container";
import { FontFamilyFaceConflictError } from "./font-library-families";
import { FontImportError, type PreparedLibraryFontFace } from "./font-import-staging";

export interface FontImportSelection {
  readonly displayName: string;
  readonly family?: string;
}

export type FontImportConflict = "face-conflict" | "duplicate-family";
export interface FontImportReview {
  readonly conflicts: ReadonlyMap<string, FontImportConflict>;
  readonly error?: "unavailable-family" | "library-full";
}

/** Rechecks current metadata before any reviewed batch can mutate the vault. */
export function planFontImport(
  prepared: readonly PreparedLibraryFontFace[],
  faces: readonly FontLibraryEntryV2[],
  selection: FontImportSelection,
): readonly FontLibraryEntryV2[] {
  if (prepared.length === 0 || prepared.length > FONT_LIMITS.libraryFaces)
    throw new FontImportError("invalid-prepared", "Select at least one prepared font.");
  const displayName = selection.displayName.trim();
  if (displayName.length === 0 || displayName.length > 128)
    throw new FontImportError("invalid-name", "Invalid font display name.");
  const { conflicts, error, planned } = inspectFontImport(prepared, faces, selection);
  const conflict = conflicts.values().next().value;
  if (conflict === "face-conflict") throw new FontFamilyFaceConflictError();
  if (conflict === "duplicate-family")
    throw new FontImportError(conflict, "This font already belongs to another family.");
  if (error === "unavailable-family")
    throw new FontImportError(error, "The selected font family is unavailable.");
  if (error === "library-full") throw new FontImportError(error, "Font library is full.");
  return planned;
}

/** Preflight uses the same face identity, style and inclusive weight ranges as admission. */
export function inspectFontImport(
  prepared: readonly PreparedLibraryFontFace[],
  faces: readonly FontLibraryEntryV2[],
  selection: FontImportSelection,
): FontImportReview & { readonly planned: readonly FontLibraryEntryV2[] } {
  const conflicts = new Map<string, FontImportConflict>();
  const target =
    selection.family === undefined
      ? undefined
      : faces.find((face) => face.family === selection.family);
  if (selection.family !== undefined && target === undefined)
    return { planned: [], conflicts, error: "unavailable-family" };
  if (prepared.length === 0) return { planned: [], conflicts };
  const family = target?.family ?? newFamily(prepared[0]!.id, faces);
  const displayName = target?.displayName ?? selection.displayName.trim();
  const result = new Map<string, FontLibraryEntryV2>();
  const existingFaces = new Map(faces.map((face) => [face.id, face]));
  const familyFaces = faces.filter((face) => face.family === family);
  const newFaces: FontLibraryEntryV2[] = [];
  for (const item of prepared) {
    if (result.has(item.id)) continue;
    const existing = existingFaces.get(item.id);
    if (existing !== undefined) {
      if (existing.family === family) result.set(item.id, existing);
      else conflicts.set(item.id, "duplicate-family");
      continue;
    }
    const { resource } = item;
    const candidate: FontLibraryEntryV2 = {
      family,
      displayName,
      id: item.id,
      weight: resource.weight,
      style: resource.style,
      ...(resource.weightRange === undefined ? {} : { weightRange: resource.weightRange }),
      ...(resource.license === undefined ? {} : { license: resource.license }),
      path: `Inkbook Fonts/${item.id}.${resource.mimeType.slice(5)}`,
    };
    if (familyFaces.some((face) => fontFacesOverlap(face, candidate)))
      conflicts.set(item.id, "face-conflict");
    for (const face of newFaces) {
      if (!fontFacesOverlap(face, candidate)) continue;
      conflicts.set(item.id, "face-conflict");
      conflicts.set(face.id, "face-conflict");
    }
    newFaces.push(candidate);
    result.set(item.id, candidate);
  }
  return {
    planned: [...result.values()],
    conflicts,
    ...(faces.length + newFaces.length > FONT_LIMITS.libraryFaces ? { error: "library-full" } : {}),
  };
}

function newFamily(id: string, faces: readonly FontLibraryEntryV2[]): string {
  let identity = BigInt(`0x${id}`);
  const occupied = new Set(faces.map((face) => face.family));
  while (occupied.has(`custom-${identity.toString(16).padStart(64, "0")}`))
    identity = (identity + 1n) % (1n << 256n);
  return `custom-${identity.toString(16).padStart(64, "0")}`;
}
