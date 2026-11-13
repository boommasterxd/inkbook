export type ExternalPanelFocusTarget = () => HTMLElement | undefined;

/** One owned source editor may share the panel's focus boundary, including its iframe host. */
export function isExternalPanelFocus(
  surface: HTMLElement,
  target: EventTarget | null,
  readTarget: ExternalPanelFocusTarget | undefined,
): boolean {
  const root = externalFocusTarget(surface, readTarget);
  if (root === undefined || target === null || !("nodeType" in target)) return false;
  return root.contains(target as Node) || root.ownerDocument.defaultView?.frameElement === target;
}

export function refreshPanelFocusBoundary(
  surface: HTMLElement,
  readTarget: ExternalPanelFocusTarget | undefined,
  phone: boolean,
): void {
  if (!phone) return;
  const modal = externalFocusTarget(surface, readTarget) === undefined ? "true" : "false";
  if (surface.getAttribute("aria-modal") !== modal) surface.setAttribute("aria-modal", modal);
}

function externalFocusTarget(
  surface: HTMLElement,
  readTarget: ExternalPanelFocusTarget | undefined,
): HTMLElement | undefined {
  const root = readTarget?.();
  if (root === undefined || !root.isConnected) return undefined;
  if (root.ownerDocument === surface.ownerDocument) return root;
  const frame = root.ownerDocument.defaultView?.frameElement;
  return frame?.isConnected === true && frame.ownerDocument === surface.ownerDocument
    ? root
    : undefined;
}

/** Keeps an owned modal sheet focused when another surface restores its old trigger. */
export function trapPhoneSheetFocus(
  surface: HTMLElement,
  initialFocus: HTMLElement,
  isTopmost: () => boolean,
  externalFocus?: ExternalPanelFocusTarget,
): () => void {
  const ownerDocument = surface.ownerDocument;
  let lastFocus = initialFocus;
  const handleFocus = (event: FocusEvent): void => {
    if (!isTopmost()) return;
    const target = event.target;
    if (
      target !== null &&
      "nodeType" in target &&
      containsOwnedMenuTarget(surface, target as Node)
    ) {
      if ("focus" in target) lastFocus = target as HTMLElement;
      return;
    }
    if (isExternalPanelFocus(surface, target, externalFocus)) return;
    const candidate =
      lastFocus.isConnected && !lastFocus.closest("[hidden], [inert]") ? lastFocus : surface;
    candidate.focus({ preventScroll: true });
    if (
      ownerDocument.activeElement === null ||
      !containsOwnedMenuTarget(surface, ownerDocument.activeElement)
    )
      surface.focus({ preventScroll: true });
  };
  ownerDocument.addEventListener("focusin", handleFocus);
  return () => ownerDocument.removeEventListener("focusin", handleFocus);
}
import { containsOwnedMenuTarget } from "../owned-menu-target";
