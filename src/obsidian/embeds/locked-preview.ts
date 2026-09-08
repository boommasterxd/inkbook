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
  const mount = (safeSvg: string, aspectRatio?: number): void => {
    if (aspectRatio !== undefined) setAspectRatio(aspectRatio);
    element.replaceChildren(createPreviewSvg(button.ownerDocument, safeSvg));
  };
  const setDescriptor = (nextDescriptor: InkbookLockedPreviewDescriptor): void => {
    if (
      samePreviewContentIdentity(currentDescriptor.contentIdentity, nextDescriptor.contentIdentity)
    ) {
      return;
    }
    sourceGeneration += 1;
    currentDescriptor = nextDescriptor;
    mount(nextDescriptor.safeSvg, nextDescriptor.aspectRatio);
  };
  const setSource = async (nextSource: string): Promise<PreviewContentIdentity | undefined> => {
    const generation = ++sourceGeneration;
    const loaded = await loadValidatedPreviewSvg(nextSource, owningWindow);
    if (generation !== sourceGeneration) return undefined;
    currentDescriptor = loaded;
    mount(loaded.safeSvg, loaded.aspectRatio);
    return loaded.contentIdentity;
  };
  mount(currentDescriptor.safeSvg);
  return {
    element: button,
    refresh: () => {
      mount(currentDescriptor.safeSvg);
    },
    setDescriptor,
    setAspectRatio,
    setSource,
  };
}
