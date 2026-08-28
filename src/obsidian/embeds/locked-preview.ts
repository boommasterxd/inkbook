import { Platform } from "obsidian";

import { createPreviewSvg, loadValidatedPreviewSvg } from "./safe-preview-svg";

export interface InkbookLockedPreviewDescriptor {
  readonly aspectRatio: number;
  readonly safeSvg: string;
}

export interface InkbookLockedPreviewSurface {
  readonly element: HTMLButtonElement;
  readonly refresh: () => void;
  readonly setAspectRatio: (aspectRatio: number) => void;
  readonly setSource: (source: string) => Promise<void>;
}

export function createInkbookLockedPreview(
  button: HTMLButtonElement,
  descriptor: InkbookLockedPreviewDescriptor,
): InkbookLockedPreviewSurface {
  if (Platform.isAndroidApp) button.classList.add("inkbook-locked-preview-android");
  const element = button.createDiv({ cls: "inkbook-locked-preview-media" });
  element.setAttribute("aria-hidden", "true");
  const owningWindow = button.ownerDocument.defaultView;
  if (owningWindow === null) throw new Error("The Inkbook preview has no owning window.");
  const setAspectRatio = (aspectRatio: number): void => {
    if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return;
    element.setCssProps({ "--inkbook-preview-aspect-ratio": String(aspectRatio) });
  };
  setAspectRatio(descriptor.aspectRatio);
  let currentSvg = descriptor.safeSvg;
  let sourceGeneration = 0;
  const mount = (safeSvg: string): void => {
    element.replaceChildren(createPreviewSvg(button.ownerDocument, safeSvg));
  };
  const setSource = async (nextSource: string): Promise<void> => {
    const generation = ++sourceGeneration;
    const safeSvg = await loadValidatedPreviewSvg(nextSource, owningWindow);
    if (generation !== sourceGeneration) return;
    currentSvg = safeSvg;
    mount(safeSvg);
  };
  mount(currentSvg);
  return {
    element: button,
    refresh: () => {
      mount(currentSvg);
    },
    setAspectRatio,
    setSource,
  };
}
