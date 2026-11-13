import type { PreparedLibraryFontFace } from "../../../src/obsidian/fonts/font-import-staging";

export function preparedLibraryFont(name = "Example.ttf", weight = 400): PreparedLibraryFontFace {
  const id = String(weight).padStart(64, "0");
  return {
    id,
    fileName: name,
    familyName: "Example",
    weight,
    style: "normal",
    resource: { id, family: "upload", weight, style: "normal", mimeType: "font/ttf", data: "AA==" },
  };
}
