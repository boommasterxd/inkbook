const MINIMUM_RADIUS = 10;
const MAXIMUM_RADIUS = 20;
const RADIUS_SHARE = 0.02;

/** The locked presentation and its static export use the same measured shell geometry. */
export function updateLockedEmbedShellRadius(root: HTMLElement, contentWidth: number): void {
  if (contentWidth <= 0) return;
  root.style.setProperty(
    "--inkbook-shell-radius",
    `${String(Math.min(MAXIMUM_RADIUS, Math.max(MINIMUM_RADIUS, contentWidth * RADIUS_SHARE)))}px`,
  );
}

/** Print layout may change width after Markdown preparation has completed. */
export function applyResponsiveLockedEmbedShell(root: HTMLElement): void {
  root.style.setProperty(
    "--inkbook-shell-radius",
    `clamp(${MINIMUM_RADIUS}px, ${RADIUS_SHARE * 100}cqw, ${MAXIMUM_RADIUS}px)`,
  );
}
