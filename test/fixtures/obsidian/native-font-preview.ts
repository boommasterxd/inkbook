import { vi } from "vitest";
import type { FontResourceV2 } from "../../../src/domain/schema/public";
import { loadBuiltinFont } from "../../../src/persistence/fonts/builtin-fonts";
import { TestWorkScheduler } from "../persistence/work-scheduler";

export async function previewFontResource(
  family = "inter",
  weight = 400,
  style: "normal" | "italic" = "normal",
): Promise<FontResourceV2> {
  const resource = await loadBuiltinFont(family, weight, style, new TestWorkScheduler());
  return { ...resource, family: `custom-${resource.id}` };
}

export function installFontPreviewHost(document: Document) {
  const owner = document.defaultView;
  if (owner === null) throw new Error("Native font fixture requires its window.");
  const retained = new Set<unknown>();
  const created: { readonly family: string; readonly bytes: number }[] = [];
  let loading = 0;
  let maximumLoading = 0;
  let load: () => Promise<void> = () => Promise.resolve();
  class NativeFont {
    public constructor(family: string, bytes: ArrayBuffer) {
      created.push({ family, bytes: bytes.byteLength });
    }
    public async load(): Promise<this> {
      loading += 1;
      maximumLoading = Math.max(maximumLoading, loading);
      try {
        await load();
        return this;
      } finally {
        loading -= 1;
      }
    }
  }
  const previousFont = Object.getOwnPropertyDescriptor(owner, "FontFace");
  const previousSet = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(owner, "FontFace", { configurable: true, value: NativeFont });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      add: (font: unknown) => retained.add(font),
      delete: (font: unknown) => retained.delete(font),
    },
  });
  return {
    retained,
    created,
    maximumLoading: () => maximumLoading,
    loading: () => loading,
    defer: (promise: Promise<void>) => {
      load = () => promise;
    },
    restore: () => {
      if (previousFont === undefined) Reflect.deleteProperty(owner, "FontFace");
      else Object.defineProperty(owner, "FontFace", previousFont);
      if (previousSet === undefined) Reflect.deleteProperty(document, "fonts");
      else Object.defineProperty(document, "fonts", previousSet);
    },
    ready: (element: HTMLElement) =>
      vi.waitFor(() => {
        if (element.dataset.inkbookFontPreview !== "ready")
          throw new Error("Preview is not ready.");
      }),
  };
}
