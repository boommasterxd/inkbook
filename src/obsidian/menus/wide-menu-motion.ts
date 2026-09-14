/** Preserve the visible entrance state before handing off to a wide menu exit. */
export function prepareWideMenuExit(surface: HTMLElement, ownerWindow: Window): void {
  const style = ownerWindow.getComputedStyle(surface);
  surface.style.setProperty(
    "--inkbook-wide-menu-exit-scale",
    !style.scale || style.scale === "none" ? "1" : style.scale,
  );
  surface.style.setProperty("--inkbook-wide-menu-exit-opacity", style.opacity || "1");
}
