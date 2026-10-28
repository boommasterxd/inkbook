import { effectiveTransitionDuration } from "../../runtime/effective-motion";
import { playMenuMotion } from "./menu-motion";

export type ChangeMenuColor = (item: HTMLElement | undefined, color?: string) => void;

const PAINT_PROPERTIES = ["background-color", "border-color", "color"] as const;
const CHOICE_SELECTOR = ".inkbook-menu-choice";
const PAINT_SELECTOR = `${CHOICE_SELECTOR}, .inkbook-shortcut-recorder`;
type Paint = Readonly<Record<(typeof PAINT_PROPERTIES)[number], string>>;
type InlinePaint = Readonly<Record<keyof Paint, { value: string; priority: string }>>;

/** Selection and gestures share one retained paint target, including interrupted changes. */
export function createMenuColorAnimator(
  root: HTMLElement,
  anchor: HTMLElement,
  ownerWindow: Window,
  isActive: (item: HTMLElement) => boolean,
  items: readonly HTMLElement[] = [...root.querySelectorAll<HTMLElement>(PAINT_SELECTOR)],
): { change: ChangeMenuColor; finish: () => void; dispose: () => void } {
  const active = new Map<HTMLElement, () => void>();
  const originals = new Map<HTMLElement, InlinePaint>();
  const read = (item: HTMLElement): Paint => {
    const style = ownerWindow.getComputedStyle(item);
    return {
      "background-color": style.backgroundColor,
      "border-color": style.borderColor,
      color: style.color,
    };
  };
  const restore = (item: HTMLElement): void => restorePaint(item, originals.get(item));
  const remember = (item: HTMLElement): void => {
    if (originals.has(item)) return;
    originals.set(item, readInlinePaint(item));
  };
  const change: ChangeMenuColor = (item, color) => {
    if (item === undefined) return;
    const current = read(item);
    remember(item);
    active.get(item)?.();
    restore(item);
    syncPaintState(item);
    if (color !== undefined || isActive(item))
      item.dataset.inkbookMenuGesture = color === "var(--interactive-hover)" ? "press" : "hover";
    else delete item.dataset.inkbookMenuGesture;
    const target = read(item);
    writePaint(item, current);
    active.set(
      item,
      playMenuMotion(
        item,
        {
          backgroundColor: [current["background-color"], target["background-color"]],
          borderColor: [current["border-color"], target["border-color"]],
          color: [current.color, target.color],
        },
        effectiveTransitionDuration(anchor, ownerWindow, "toolActiveState"),
        () => restore(item),
      ),
    );
  };
  for (const item of items) {
    if (!item.matches(PAINT_SELECTOR) || item.closest("[data-inkbook-feedback-owner]") !== root)
      continue;
    remember(item);
    syncPaintState(item);
  }
  const observer = observeSelection(root, ownerWindow, change);
  return {
    change,
    finish: () => {
      for (const [item, stop] of active) {
        stop();
        restore(item);
      }
      active.clear();
    },
    dispose: () => {
      observer.disconnect();
      for (const stop of active.values()) stop();
      for (const item of originals.keys()) {
        restore(item);
        delete item.dataset.inkbookMenuGesture;
        delete item.dataset.inkbookChoiceState;
        delete item.dataset.inkbookRecordingState;
      }
      active.clear();
      originals.clear();
    },
  };
}

/** Keep the previously painted state until the immediate semantic update can be animated. */
function syncPaintState(item: HTMLElement): void {
  if (item.matches(CHOICE_SELECTOR))
    item.dataset.inkbookChoiceState =
      item.getAttribute("aria-pressed") === "true" ? "selected" : "unselected";
  else if (item.matches(".inkbook-shortcut-recorder"))
    item.dataset.inkbookRecordingState = item.dataset.recording === "true" ? "true" : "false";
}

function writePaint(item: HTMLElement, paint: Paint): void {
  for (const property of PAINT_PROPERTIES) item.style.setProperty(property, paint[property]);
}

function readInlinePaint(item: HTMLElement): InlinePaint {
  const read = (property: keyof Paint) => ({
    value: item.style.getPropertyValue(property),
    priority: item.style.getPropertyPriority(property),
  });
  return {
    "background-color": read("background-color"),
    "border-color": read("border-color"),
    color: read("color"),
  };
}

function restorePaint(item: HTMLElement, original: InlinePaint | undefined): void {
  for (const property of PAINT_PROPERTIES) {
    const stored = original?.[property];
    if (stored?.value) item.style.setProperty(property, stored.value, stored.priority);
    else item.style.removeProperty(property);
  }
}

function observeSelection(
  root: HTMLElement,
  ownerWindow: Window,
  change: ChangeMenuColor,
): MutationObserver {
  const observerConstructor = (
    ownerWindow as Window & { MutationObserver: typeof MutationObserver }
  ).MutationObserver;
  const observer = new observerConstructor((records) => {
    for (const item of new Set(records.map((record) => record.target as HTMLElement))) {
      if (item.matches(PAINT_SELECTOR) && item.closest("[data-inkbook-feedback-owner]") === root)
        change(item);
    }
  });
  observer.observe(root, {
    attributes: true,
    attributeFilter: ["aria-pressed", "data-recording"],
    subtree: true,
  });
  return observer;
}
