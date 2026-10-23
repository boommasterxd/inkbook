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
  const active = new Map<HTMLElement, { stop: () => void; target: Paint }>();
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
  const resting = (item: HTMLElement): Paint => {
    restore(item);
    if (item.matches(".inkbook-shortcut-recorder")) return recorderPaint(item, isActive(item));
    const paint = read(item);
    return item.matches(`${CHOICE_SELECTOR}[aria-pressed='true']`)
      ? {
          "background-color": "var(--inkbook-menu-choice-selected-background)",
          "border-color": "var(--inkbook-menu-choice-selected-border)",
          color: "var(--text-normal)",
        }
      : paint;
  };
  const settle = (item: HTMLElement, target: Paint): void => {
    restore(item);
    if (item.matches(`${CHOICE_SELECTOR}[aria-pressed='true'], .inkbook-shortcut-recorder`))
      writePaint(item, target);
    else if (isActive(item)) item.style.backgroundColor = target["background-color"];
  };
  const change: ChangeMenuColor = (item, color) => {
    if (item === undefined) return;
    const current = buttonStartPaint(item, read(item));
    remember(item);
    active.get(item)?.stop();
    const target = {
      ...resting(item),
      ...(color !== undefined || isActive(item)
        ? { "background-color": gestureColor(item, color) }
        : {}),
    };
    writePaint(item, current);
    active.set(item, {
      target,
      stop: playMenuMotion(
        item,
        {
          backgroundColor: [current["background-color"], target["background-color"]],
          borderColor: [current["border-color"], target["border-color"]],
          color: [current.color, target.color],
        },
        effectiveTransitionDuration(anchor, ownerWindow, "toolActiveState"),
        () => settle(item, target),
      ),
    });
  };
  for (const item of items) {
    if (!item.matches(PAINT_SELECTOR) || item.closest("[data-inkbook-feedback-owner]") !== root)
      continue;
    remember(item);
    item.dataset.inkbookMotionChoice = "true";
    settle(item, resting(item));
  }
  const observer = observeSelection(root, ownerWindow, change);
  return {
    change,
    finish: () => {
      for (const [item, animation] of active) {
        animation.stop();
        settle(item, animation.target);
      }
      active.clear();
    },
    dispose: () => {
      observer.disconnect();
      for (const animation of active.values()) animation.stop();
      for (const item of originals.keys()) {
        restore(item);
        delete item.dataset.inkbookMotionChoice;
      }
      active.clear();
      originals.clear();
    },
  };
}

function recorderPaint(item: HTMLElement, active: boolean): Paint {
  return {
    "background-color": "var(--background-primary)",
    "border-color":
      item.dataset.recording === "true" || active
        ? "var(--interactive-accent)"
        : "var(--background-modifier-border)",
    color: "var(--text-normal)",
  };
}

function buttonStartPaint(item: HTMLElement, paint: Paint): Paint {
  if (!item.matches(".inkbook-dialog-actions button") || item.style.backgroundColor !== "")
    return paint;
  return {
    ...paint,
    "background-color": dialogButtonBackground(item, "rest"),
  };
}

function gestureColor(item: HTMLElement, color: string | undefined): string {
  if (item.matches(".inkbook-shortcut-recorder")) return "var(--background-primary)";
  if (item.matches(".inkbook-dialog-actions button"))
    return dialogButtonBackground(item, color === "var(--interactive-hover)" ? "press" : "hover");
  return color ?? "var(--background-modifier-hover)";
}

/** Host variants keep their paired foreground, including destructive buttons with white text. */
function dialogButtonBackground(item: HTMLElement, phase: "rest" | "hover" | "press"): string {
  if (item.classList.contains("mod-warning")) {
    if (phase === "press") return "var(--inkbook-dialog-danger-pressed)";
    return phase === "hover"
      ? "var(--inkbook-dialog-danger-hover)"
      : "var(--inkbook-dialog-danger-background)";
  }
  if (item.classList.contains("mod-cta"))
    return phase === "rest" ? "var(--interactive-accent)" : "var(--interactive-accent-hover)";
  return phase === "rest" ? "var(--interactive-normal)" : "var(--interactive-hover)";
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
