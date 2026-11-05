import type { VisibleOwnerBoundary } from "./visible-owner-boundary";

/** Keeps a decorative layer inside the owned canvas stacking context across handoffs. */
export function bindFeedbackCanvas(
  presentation: HTMLElement,
  backdrop: HTMLElement,
  resize: ResizeObserver | undefined,
  schedule: () => void,
): { current(): HTMLElement; dispose(): void } {
  let canvas = presentation;
  let preview: Element | undefined;
  let chrome: Element | undefined;
  let active = true;
  const retarget = (): HTMLElement => {
    const next = resolveFeedbackCanvas(presentation);
    if (next !== canvas) {
      if (canvas !== presentation) resize?.unobserve(canvas);
      canvas = next;
      if (canvas !== presentation) resize?.observe(canvas);
    }
    if (backdrop.parentElement !== canvas) canvas.appendChild(backdrop);
    return canvas;
  };
  const observe = (): void => {
    const next = [...presentation.children].find((child) =>
      child.classList.contains("inkbook-locked-preview"),
    );
    const nextChrome = [...presentation.children].find((child) =>
      child.classList.contains("inkbook-editor-chrome"),
    );
    if (next === preview && nextChrome === chrome) return;
    preview = next;
    chrome = nextChrome;
    mutations?.disconnect();
    mutations?.observe(presentation, { childList: true });
    if (preview !== undefined)
      mutations?.observe(preview, { attributes: true, attributeFilter: ["hidden"] });
    if (chrome !== undefined) mutations?.observe(chrome, { childList: true });
  };
  const ownerWindow = presentation.ownerDocument.defaultView;
  const mutations =
    ownerWindow === null || !("MutationObserver" in ownerWindow)
      ? undefined
      : new ownerWindow.MutationObserver(() => {
          if (!active) return;
          // Parent ownership changes before paint; geometry remains frame-coalesced.
          retarget();
          observe();
          schedule();
        });
  mutations?.observe(presentation, { childList: true });
  observe();
  retarget();
  return {
    current: retarget,
    dispose: () => {
      active = false;
      mutations?.disconnect();
    },
  };
}

/** Presentation height can clip a fully measured canvas during its existing handoff. */
export function clipCanvasFeedbackBoundary(
  presentation: HTMLElement,
  canvas: HTMLElement,
  boundary: VisibleOwnerBoundary,
): VisibleOwnerBoundary {
  if (canvas === presentation) return boundary;
  const clip = presentation.getBoundingClientRect();
  return {
    left: Math.max(boundary.left, clip.left),
    right: Math.min(boundary.right, clip.right),
    top: Math.max(boundary.top, clip.top),
    bottom: Math.min(boundary.bottom, clip.bottom),
  };
}

/** Only owned direct children are inspected; retained SVG ink is never traversed. */
function resolveFeedbackCanvas(presentation: HTMLElement): HTMLElement {
  let canvas: HTMLElement | undefined;
  for (const child of presentation.children) {
    if (child.classList.contains("inkbook-locked-preview") && !(child as HTMLElement).hidden)
      return child as HTMLElement;
    if (child.classList.contains("inkbook-editor-chrome")) {
      for (const surface of child.children) {
        if (surface.classList.contains("inkbook-background-container"))
          canvas = surface as HTMLElement;
      }
    }
  }
  return canvas ?? presentation;
}
