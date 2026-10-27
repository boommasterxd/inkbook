/** Owns explicit keyboard-navigation feedback independently of browser focus heuristics. */
export function registerFocusNavigation(root: HTMLElement, initial = false): () => void {
  const document = root.ownerDocument;
  // Observe contact before the canvas boundary consumes touch and pen events.
  const pointerOwner = document.defaultView ?? document;
  const setNavigation = (enabled: boolean): void => {
    const value = String(enabled);
    if (root.dataset.inkbookKeyboardNavigation !== value) {
      root.dataset.inkbookKeyboardNavigation = value;
    }
  };
  const pointer = (): void => setNavigation(false);
  const keyboard = (event: KeyboardEvent): void => {
    if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) {
      setNavigation(false);
      return;
    }
    if (event.key === "Tab") {
      setNavigation(true);
      return;
    }
    const target = event.target;
    const navigable =
      target !== null &&
      "nodeType" in target &&
      root.contains(target as Node) &&
      "closest" in target &&
      typeof target.closest === "function" &&
      (target as Element).closest('[role="toolbar"], .inkbook-adaptive-panel') !== null;
    if (navigable && /^(Arrow(Up|Down|Left|Right)|Home|End)$/.test(event.key)) {
      setNavigation(true);
    } else if (!["Shift", "Enter", " ", "Escape"].includes(event.key)) {
      setNavigation(false);
    }
  };
  setNavigation(initial);
  document.addEventListener("keydown", keyboard, true);
  pointerOwner.addEventListener("pointerdown", pointer, true);
  return () => {
    document.removeEventListener("keydown", keyboard, true);
    pointerOwner.removeEventListener("pointerdown", pointer, true);
    delete root.dataset.inkbookKeyboardNavigation;
  };
}

/** Cycles a modal surface's current controls without letting Tab reach the host. */
export function cycleModalFocus(event: KeyboardEvent, focusable: readonly HTMLElement[]): void {
  if (event.key !== "Tab" || event.defaultPrevented || focusable.length === 0) return;
  const active = focusable[0]?.ownerDocument.activeElement;
  const index = focusable.indexOf(active as HTMLElement);
  const next = event.shiftKey
    ? focusable[(index <= 0 ? focusable.length : index) - 1]
    : focusable[(index + 1) % focusable.length];
  event.preventDefault();
  next?.focus({ preventScroll: true });
}
