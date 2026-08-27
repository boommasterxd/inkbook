import { effectiveTransitionDuration } from "../runtime/effective-motion";

const DESKTOP_MENU_QUERY = "(width > 600px) and (hover: hover) and (pointer: fine)";
const MENU_CARD_STAGGER_MS = 50;
const EXIT_CLEANUP_GRACE_MS = 50;

export type MenuMotionKind = "cards" | "surface";

export interface MenuMotionBounds {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

export interface MenuMotionHandle {
  readonly bounds: MenuMotionBounds;
  cancel(): void;
  exit(): void;
}

export function createDesktopMenuMotion(options: {
  readonly kind: MenuMotionKind;
  readonly marker: HTMLElement;
  readonly motionSource: HTMLElement;
  readonly ownerWindow: Window;
  readonly previousBounds?: MenuMotionBounds;
}): MenuMotionHandle | undefined {
  if (!options.ownerWindow.matchMedia(DESKTOP_MENU_QUERY).matches) return undefined;
  const surface = menuSurface(options.marker);
  if (surface === undefined) return undefined;
  const durationMs = effectiveTransitionDuration(
    options.motionSource,
    options.ownerWindow,
    "conditionalToolbarControl",
  );
  const staggerMs = durationMs === 0 ? 0 : MENU_CARD_STAGGER_MS;
  const bounds = elementBounds(surface);
  configureSurface(surface, options.kind, durationMs, staggerMs);
  configureEntrance(surface, bounds, options.previousBounds);
  let completed = false;
  return {
    bounds,
    cancel: () => {
      completed = true;
    },
    exit: () => {
      if (completed) return;
      completed = true;
      if (durationMs === 0) return;
      mountExitClone(surface, bounds, options.kind, durationMs, staggerMs, options.ownerWindow);
    },
  };
}

function configureSurface(
  surface: HTMLElement,
  kind: MenuMotionKind,
  durationMs: number,
  staggerMs: number,
): void {
  surface.classList.add("inkbook-menu-motion", `inkbook-menu-motion-${kind}`);
  surface.style.setProperty("--inkbook-menu-motion-duration", `${String(durationMs)}ms`);
  if (kind !== "cards") return;
  const controls = surface.querySelector<HTMLElement>(".inkbook-menu-controls");
  const cards = [...(controls?.children ?? [])].filter((child) =>
    child.classList.contains("inkbook-menu-control"),
  ) as HTMLElement[];
  for (const [index, card] of cards.entries()) {
    card.style.setProperty("--inkbook-menu-card-delay", `${String(index * staggerMs)}ms`);
    card.style.setProperty(
      "--inkbook-menu-card-exit-delay",
      `${String((cards.length - index - 1) * staggerMs)}ms`,
    );
  }
}

function configureEntrance(
  surface: HTMLElement,
  bounds: MenuMotionBounds,
  previous: MenuMotionBounds | undefined,
): void {
  if (previous === undefined || surface.classList.contains("inkbook-menu-motion-cards")) {
    surface.classList.add("inkbook-menu-presence-entering");
    return;
  }
  const previousCenterX = previous.left + previous.width / 2;
  const previousCenterY = previous.top + previous.height / 2;
  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;
  surface.style.setProperty("--inkbook-menu-morph-scale-x", String(previous.width / bounds.width));
  surface.style.setProperty(
    "--inkbook-menu-morph-scale-y",
    String(previous.height / bounds.height),
  );
  surface.style.setProperty(
    "--inkbook-menu-morph-translate-x",
    `${String(previousCenterX - centerX)}px`,
  );
  surface.style.setProperty(
    "--inkbook-menu-morph-translate-y",
    `${String(previousCenterY - centerY)}px`,
  );
  surface.classList.add("inkbook-menu-presence-morphing");
}

function mountExitClone(
  surface: HTMLElement,
  bounds: MenuMotionBounds,
  kind: MenuMotionKind,
  durationMs: number,
  staggerMs: number,
  ownerWindow: Window,
): void {
  const clone = surface.cloneNode(true) as HTMLElement;
  clone.classList.remove("inkbook-menu-presence-entering", "inkbook-menu-presence-morphing");
  clone.classList.add("inkbook-menu-exit-clone", "inkbook-menu-presence-exiting");
  clone.setAttribute("aria-hidden", "true");
  clone.inert = true;
  const position = {
    height: `${String(bounds.height)}px`,
    inset: "auto",
    left: `${String(bounds.left)}px`,
    top: `${String(bounds.top)}px`,
    width: `${String(bounds.width)}px`,
  };
  for (const [property, value] of Object.entries(position)) {
    clone.style.setProperty(property, value);
  }
  clone.ownerDocument.body.append(clone);
  const cardCount =
    kind === "cards"
      ? clone.querySelectorAll(".inkbook-menu-controls > .inkbook-menu-control").length
      : 0;
  const totalMs = durationMs + Math.max(0, cardCount - 1) * staggerMs;
  ownerWindow.setTimeout(() => clone.remove(), totalMs + EXIT_CLEANUP_GRACE_MS);
}

function menuSurface(marker: HTMLElement): HTMLElement | undefined {
  let current: HTMLElement | null = mountedMarker(marker) ?? null;
  while (current !== null) {
    if (current.classList.contains("menu")) return current;
    current = current.parentElement;
  }
  return undefined;
}

function mountedMarker(marker: HTMLElement): HTMLElement | undefined {
  if (marker.isConnected) return marker;
  const markerClass = [...marker.classList].find((className) =>
    className.startsWith("inkbook-menu-motion-id-"),
  );
  if (markerClass === undefined) return undefined;
  const mounted = marker.ownerDocument.getElementsByClassName(markerClass)[0];
  const ownerWindow = marker.ownerDocument.defaultView;
  if (ownerWindow === null) return undefined;
  return mounted instanceof ownerWindow.HTMLElement ? mounted : undefined;
}

function elementBounds(element: HTMLElement): MenuMotionBounds {
  const bounds = element.getBoundingClientRect();
  return Object.freeze({
    height: bounds.height,
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
  });
}
