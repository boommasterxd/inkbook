import type { FontLibraryEntryV2 } from "../../domain/settings";
import { FONT_LIMITS } from "../../persistence/fonts/font-container";
import { assertAvailableFamilyFace } from "./font-library-families";
import { FontImportError, type PreparedLibraryFontFace } from "./font-import-staging";

export interface FontImportSelection {
  readonly displayName: string;
  readonly family?: string;
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
  const target =
    selection.family === undefined
      ? undefined
      : faces.find((face) => face.family === selection.family);
  if (selection.family !== undefined && target === undefined)
    throw new FontImportError("unavailable-family", "The selected font family is unavailable.");
  const family = target?.family ?? newFamily(prepared[0]!.id, faces);
  const result = new Map<string, FontLibraryEntryV2>();
  for (const item of prepared) {
    if (result.has(item.id)) continue;
    const existing = faces.find((face) => face.id === item.id);
    if (existing !== undefined) {
      if (existing.family !== family)
        throw new FontImportError(
          "duplicate-family",
          "This font already belongs to another family.",
        );
      result.set(item.id, existing);
      continue;
    }
    const { resource } = item;
    const candidate: FontLibraryEntryV2 = {
      family,
      displayName: target?.displayName ?? displayName,
      id: item.id,
      weight: resource.weight,
      style: resource.style,
      ...(resource.weightRange === undefined ? {} : { weightRange: resource.weightRange }),
      ...(resource.license === undefined ? {} : { license: resource.license }),
      path: `Inkbook Fonts/${item.id}.${resource.mimeType.slice(5)}`,
    };
    assertAvailableFamilyFace([...faces, ...result.values()], candidate);
    result.set(item.id, candidate);
  }
  const added = [...result.values()].filter((face) => !faces.some((item) => item.id === face.id));
  if (faces.length + added.length > FONT_LIMITS.libraryFaces)
    throw new FontImportError("library-full", "Font library is full.");
  return [...result.values()];
}

function newFamily(id: string, faces: readonly FontLibraryEntryV2[]): string {
  let identity = BigInt(`0x${id}`);
  const occupied = new Set(faces.map((face) => face.family));
  while (occupied.has(`custom-${identity.toString(16).padStart(64, "0")}`))
    identity = (identity + 1n) % (1n << 256n);
  return `custom-${identity.toString(16).padStart(64, "0")}`;
}
