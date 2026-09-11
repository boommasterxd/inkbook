/** Keeps an owned modal sheet focused when a retiring native menu restores its old trigger. */
export function trapPhoneSheetFocus(
  surface: HTMLElement,
  initialFocus: HTMLElement,
  isTopmost: () => boolean,
): () => void {
  const ownerDocument = surface.ownerDocument;
  let lastFocus = initialFocus;
  const handleFocus = (event: FocusEvent): void => {
    if (!isTopmost()) return;
    const target = event.target;
    if (target !== null && "nodeType" in target && surface.contains(target as Node)) {
      if ("focus" in target) lastFocus = target as HTMLElement;
      return;
    }
    const candidate =
      lastFocus.isConnected && !lastFocus.closest("[hidden], [inert]") ? lastFocus : surface;
    candidate.focus({ preventScroll: true });
    if (!surface.contains(ownerDocument.activeElement)) surface.focus({ preventScroll: true });
  };
  ownerDocument.addEventListener("focusin", handleFocus);
  return () => ownerDocument.removeEventListener("focusin", handleFocus);
}
