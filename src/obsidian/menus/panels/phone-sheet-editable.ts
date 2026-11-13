/** Reveals focus within the owned scrollport, including controls in dialog bodies. */
export function revealPhoneSheetFocus(
  scroll: HTMLElement,
  viewport: { readonly top: number; readonly height: number },
  includeControls = false,
): void {
  const active = scroll.ownerDocument.activeElement;
  if (active === null || !scroll.contains(active) || (!includeControls && !isEditable(active)))
    return;
  const bounds = scroll.getBoundingClientRect();
  const top = Math.max(bounds.top, viewport.top);
  const bottom = Math.min(bounds.bottom, viewport.top + viewport.height);
  if (bottom <= top) return;
  const field = active.getBoundingClientRect();
  if (field.top >= top && field.bottom <= bottom) return;
  // A field taller than the visible area cannot fit; keep its visible portion stable.
  if (field.top <= top && field.bottom >= bottom) return;
  const delta = field.top < top ? field.top - top : field.bottom - bottom;
  const maximum = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
  scroll.scrollTop = Math.min(maximum, Math.max(0, scroll.scrollTop + delta));
}

function isEditable(element: Element): boolean {
  if (element.hasAttribute("disabled") || element.hasAttribute("readonly")) return false;
  if (
    element.matches(
      "textarea, [contenteditable='true'], [contenteditable=''], [contenteditable='plaintext-only']",
    )
  )
    return true;
  return element.matches(
    "input:not([type='checkbox'], [type='radio'], [type='range'], [type='color'], [type='file'], [type='button'], [type='submit'], [type='reset'], [type='hidden'])",
  );
}
