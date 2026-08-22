export interface InkbookLockedPreviewDescriptor {
  readonly aspectRatio: number;
}

export interface InkbookLockedPreviewSurface {
  readonly element: HTMLElement;
  readonly refresh: () => void;
  readonly setSource: (source: string) => void;
}

export function createInkbookLockedPreview(
  button: HTMLButtonElement,
  source: string,
  descriptor: InkbookLockedPreviewDescriptor,
): InkbookLockedPreviewSurface {
  const element = button.createDiv({ cls: "inkbook-locked-preview-media" });
  element.setAttribute("aria-hidden", "true");
  element.setCssProps({ aspectRatio: String(descriptor.aspectRatio) });
  let currentSource = source;
  const setSource = (nextSource: string): void => {
    currentSource = nextSource;
    element.setCssProps({ backgroundImage: cssImageUrl(currentSource) });
  };
  setSource(source);
  return {
    element,
    refresh: () => {
      element.setCssProps({ backgroundImage: "none" });
      element.getBoundingClientRect();
      element.setCssProps({ backgroundImage: cssImageUrl(currentSource) });
    },
    setSource,
  };
}

function cssImageUrl(source: string): string {
  return `url(${JSON.stringify(source)})`;
}
