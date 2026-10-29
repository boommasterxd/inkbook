/** Reveal within plugin-owned horizontal scrollports without moving the note vertically. */
export function revealOnboardingTarget(target: HTMLElement): void {
  for (const selector of [
    ".inkbook-toolbar-context-actions",
    ".inkbook-toolbar-composition-scrollable",
  ]) {
    const scrollport = target.closest<HTMLElement>(selector);
    if (scrollport === null) continue;
    const viewport = scrollport.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    if (rect.left < viewport.left) scrollport.scrollLeft += rect.left - viewport.left;
    else if (rect.right > viewport.right) scrollport.scrollLeft += rect.right - viewport.right;
  }
}
