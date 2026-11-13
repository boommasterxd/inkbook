import { vi } from "vitest";
import { serializeFontStylesheet } from "../../../src/persistence/serialization/output/text-fonts";
import { TextEditingDocumentAssets } from "../../../src/rendering/scene/text-editing-document-assets";

export function loadedEditorFace(index = 0, status: FontFaceLoadStatus = "loaded"): FontFace {
  return {
    family: `"inkbook-face-${index.toString(16).padStart(64, "0")}"`,
    weight: "400",
    style: "normal",
    status,
  } as FontFace;
}

/** Isolates native font loading while retaining real document/style lifecycle boundaries. */
export function textEditorAssetsFixture(faces: readonly FontFace[]) {
  const source = document.implementation.createHTMLDocument("Drawing");
  const target = document.implementation.createHTMLDocument("Native editor");
  const fonts = new Set(faces);
  const load = vi.fn<(font: string) => Promise<FontFace[]>>(async () => [loadedEditorFace()]);
  Object.defineProperty(source, "fonts", { value: fonts });
  Object.defineProperty(target, "fonts", { value: { load } });
  let stylesheet = serializeFontStylesheet([
    {
      id: "0".repeat(64),
      family: "inter",
      weight: 400,
      style: "normal",
      mimeType: "font/woff2",
      data: "AA==",
    },
  ]);
  const releaseTheme = vi.fn();
  return {
    source,
    target,
    fonts,
    load,
    releaseTheme,
    stylesheet: () => stylesheet,
    replaceStylesheet: () => {
      stylesheet += "\n";
    },
    mount: () =>
      new TextEditingDocumentAssets({
        document: target,
        source,
        stylesheet: () => stylesheet,
        releaseTheme,
      }),
  };
}
