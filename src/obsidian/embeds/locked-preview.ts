import { Platform } from "obsidian";

import {
  createPreviewSvg,
  loadValidatedPreviewSvg,
  samePreviewContentIdentity,
  type PreviewContentIdentity,
} from "./safe-preview-svg";

export interface InkbookLockedPreviewDescriptor {
  readonly aspectRatio: number;
  readonly contentIdentity: PreviewContentIdentity;
  readonly safeSvg: string;
}

export interface InkbookLockedPreviewSurface {
  readonly element: HTMLButtonElement;
  readonly refresh: () => void;
  readonly dispose: () => void;
  readonly setDescriptor: (descriptor: InkbookLockedPreviewDescriptor) => void;
  readonly setAspectRatio: (aspectRatio: number) => void;
  readonly setSource: (source: string) => Promise<PreviewContentIdentity | undefined>;
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
  let currentDescriptor = descriptor;
  let sourceGeneration = 0;
  let disposed = false;
  let mountedIdentity: PreviewContentIdentity | undefined;
  const refresh = (): void => {
    if (disposed || button.hidden) return;
    if (
      mountedIdentity !== undefined &&
      samePreviewContentIdentity(mountedIdentity, currentDescriptor.contentIdentity)
    )
      return;
    const svg = createPreviewSvg(button.ownerDocument, currentDescriptor.safeSvg);
    setAspectRatio(currentDescriptor.aspectRatio);
    element.replaceChildren(svg);
    mountedIdentity = currentDescriptor.contentIdentity;
  };
  const setDescriptor = (nextDescriptor: InkbookLockedPreviewDescriptor): void => {
    if (disposed) return;
    sourceGeneration += 1;
    if (
      samePreviewContentIdentity(currentDescriptor.contentIdentity, nextDescriptor.contentIdentity)
    ) {
      return;
    }
    currentDescriptor = nextDescriptor;
    refresh();
  };
  const setSource = async (nextSource: string): Promise<PreviewContentIdentity | undefined> => {
    if (disposed) return undefined;
    const generation = ++sourceGeneration;
    const loaded = await loadValidatedPreviewSvg(nextSource, owningWindow);
    if (disposed || generation !== sourceGeneration) return undefined;
    currentDescriptor = loaded;
    refresh();
    return loaded.contentIdentity;
  };
  refresh();
  return {
    element: button,
    refresh,
    dispose: () => {
      disposed = true;
      sourceGeneration += 1;
    },
    setDescriptor,
    setAspectRatio,
    setSource,
  };
}
