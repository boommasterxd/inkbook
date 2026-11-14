import type { FontResourceV2 } from "../../domain/schema/public";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { fontCssFamily } from "../../domain/text/font-family";
import { decodeFontResource } from "../../persistence/fonts/font-resources";
import { inspectFont } from "../../persistence/fonts/font-validation";

export interface FontPreviewBudget {
  readonly bytes: number;
  readonly decodedBytes: number;
}

export interface NativeFontPreview extends FontPreviewBudget {
  readonly family: string;
  readonly weight: number;
  readonly style: "normal" | "italic";
  dispose(): void;
}

/** UI-only native faces have their own alias and never enter document stylesheets. */
export async function loadNativeFontPreview(
  resource: FontResourceV2,
  options: {
    readonly document: Document;
    readonly scheduler: WorkScheduler;
    readonly signal: AbortSignal;
    readonly admit?: (budget: FontPreviewBudget) => boolean;
  },
): Promise<NativeFontPreview | undefined> {
  const bytes = await decodeFontResource(resource, options.scheduler, options.signal);
  const budget = { bytes: bytes.length, decodedBytes: inspectFont(bytes).decodedBytes };
  if (options.admit?.(budget) === false) return undefined;
  options.signal.throwIfAborted();
  const ownerWindow = options.document.defaultView;
  if (ownerWindow === null) throw new Error("Font previews require their owning window.");
  const family = fontCssFamily(`preview-${resource.id}`);
  const native = new ownerWindow.FontFace(family, bytes.buffer, {
    weight: resource.weightRange?.join(" ") ?? String(resource.weight),
    style: resource.style,
  });
  await native.load();
  options.signal.throwIfAborted();
  options.document.fonts.add(native);
  let disposed = false;
  return {
    ...budget,
    family,
    weight: resource.weight,
    style: resource.style,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      options.document.fonts.delete(native);
    },
  };
}

const PREVIEW_PROPERTIES = ["font-family", "font-weight", "font-style"] as const;

export function captureFontPreviewStyle(element: HTMLElement): () => void {
  const previous = PREVIEW_PROPERTIES.map((property) => ({
    property,
    value: element.style.getPropertyValue(property),
    priority: element.style.getPropertyPriority(property),
  }));
  return () => {
    for (const { property, value, priority } of previous) {
      if (value === "") element.style.removeProperty(property);
      else element.style.setProperty(property, value, priority);
    }
  };
}

export function applyFontPreview(element: HTMLElement, preview: NativeFontPreview): void {
  element.style.setProperty("font-family", preview.family);
  element.style.setProperty("font-weight", String(preview.weight));
  element.style.setProperty("font-style", preview.style);
}
