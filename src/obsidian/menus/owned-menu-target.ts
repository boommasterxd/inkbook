/** Includes a floating owned control whose anchor remains inside the menu surface. */
export function containsOwnedMenuTarget(surface: HTMLElement, target: Node): boolean {
  if (surface.contains(target)) return true;
  const element = target.nodeType === 1 ? (target as Element) : target.parentElement;
  const anchorId = element?.closest<HTMLElement>("[data-inkbook-menu-anchor]")?.dataset
    .inkbookMenuAnchor;
  const anchor = anchorId === undefined ? null : surface.ownerDocument.getElementById(anchorId);
  return anchor !== null && surface.contains(anchor);
}
