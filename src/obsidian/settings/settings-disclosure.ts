import { Platform, setIcon } from "obsidian";
import {
  registerKeyboardPress,
  registerOwnedMotionPress,
} from "../../rendering/motion/keyboard-press";
import { observeEffectiveMotion, type ObserveMotion } from "../runtime/effective-motion";
import { hover } from "motion";
import {
  isReducedMotion,
  STANDARD_EASING,
  type MotionPreference,
} from "../../rendering/motion/transitions";
import { animateOwnedElement } from "../runtime/element-motion";

export interface SettingsDisclosure {
  readonly content: HTMLElement;
  readonly panel: HTMLElement;
  readonly trigger: HTMLButtonElement;
  readonly setExpanded: (expanded: boolean, reducedMotion: boolean) => void;
  readonly dispose: () => void;
}

export interface SettingsDisclosureOptions {
  readonly contentClass?: string;
  readonly description: string;
  readonly expanded: boolean;
  readonly panelId: string;
  readonly observeMotion?: ObserveMotion;
  readonly readMotion?: () => MotionPreference;
  readonly sectionClass?: string;
  readonly title: string;
  readonly triggerClass?: string;
}

export function createSettingsDisclosure(
  container: HTMLElement,
  options: SettingsDisclosureOptions,
): SettingsDisclosure {
  const section = container.createEl("section", { cls: "inkbook-settings-tool-section" });
  if (options.sectionClass !== undefined) section.classList.add(options.sectionClass);
  const trigger = section.createEl("button", { cls: "inkbook-settings-tool-trigger" });
  if (options.triggerClass !== undefined) trigger.classList.add(options.triggerClass);
  if (Platform.isMobile) trigger.classList.add("inkbook-settings-tool-trigger-touch");
  const descriptionId = `${options.panelId}-description`;
  trigger.type = "button";
  trigger.setAttribute("aria-controls", options.panelId);
  trigger.setAttribute("aria-describedby", descriptionId);
  trigger.setAttribute("aria-expanded", String(options.expanded));
  trigger.createSpan({ cls: "inkbook-settings-tool-title", text: options.title });
  const accessibleDescription = trigger.createSpan({
    cls: "inkbook-menu-visually-hidden",
    text: options.description,
  });
  accessibleDescription.id = descriptionId;
  const chevron = trigger.createSpan({ cls: "inkbook-settings-tool-chevron" });
  setIcon(chevron, "chevron-right");

  const panel = section.createDiv({ cls: "inkbook-settings-tool-panel" });
  panel.id = options.panelId;
  panel.hidden = !options.expanded;
  panel.inert = !options.expanded;
  const content = panel.createDiv({ cls: "inkbook-settings-tool-panel-content" });
  if (options.contentClass !== undefined) content.classList.add(options.contentClass);
  content.createEl("p", {
    cls: "inkbook-settings-tool-description",
    text: options.description,
  });
  return { content, panel, trigger, ...bindDisclosureMotion(trigger, chevron, options) };
}

function bindDisclosureMotion(
  trigger: HTMLButtonElement,
  chevron: HTMLElement,
  options: SettingsDisclosureOptions,
): Pick<SettingsDisclosure, "setExpanded" | "dispose"> {
  let chevronAnimation: ReturnType<typeof animateOwnedElement> | undefined;
  let backgroundAnimation: ReturnType<typeof animateOwnedElement> | undefined;
  let expanded = options.expanded;
  let hovering = false;
  let pressing = false;
  const reducedMotion = (): boolean =>
    isReducedMotion(
      options.readMotion?.() ?? "system",
      trigger.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
  const paint = (highlight: boolean): void => {
    backgroundAnimation?.stop();
    backgroundAnimation = animateOwnedElement(
      trigger,
      { backgroundColor: highlight ? "var(--background-modifier-hover)" : "rgba(0, 0, 0, 0)" },
      { duration: reducedMotion() ? 0 : 0.12, ease: STANDARD_EASING },
    );
  };
  const onHoverStart = (): (() => void) => {
    hovering = true;
    paint(true);
    return () => {
      hovering = false;
      paint(pressing);
    };
  };
  const onPressStart = (): (() => void) => {
    pressing = true;
    paint(true);
    return () => {
      pressing = false;
      paint(hovering);
    };
  };
  const stopGestures = bindDisclosureGestures(trigger, onHoverStart, onPressStart);
  const setExpanded = (nextExpanded: boolean, reducedMotion: boolean): void => {
    expanded = nextExpanded;
    chevronAnimation?.stop();
    if (reducedMotion) {
      chevron.style.rotate = expanded ? "90deg" : "0deg";
      return;
    }
    chevronAnimation = animateOwnedElement(
      chevron,
      { rotate: expanded ? "90deg" : "0deg" },
      {
        duration: 0.12,
        ease: STANDARD_EASING,
      },
    );
  };
  chevron.style.rotate = options.expanded ? "90deg" : "0deg";
  const releasePreference = observeEffectiveMotion(
    trigger,
    options.readMotion,
    (reduced) => {
      if (!reduced) return;
      chevronAnimation?.stop();
      backgroundAnimation?.stop();
      chevron.style.rotate = expanded ? "90deg" : "0deg";
      trigger.style.backgroundColor =
        hovering || pressing ? "var(--background-modifier-hover)" : "rgba(0, 0, 0, 0)";
    },
    options.observeMotion,
  );
  return {
    setExpanded,
    dispose: () => {
      releasePreference();
      stopGestures();
      backgroundAnimation?.stop();
      chevronAnimation?.stop();
    },
  };
}

function bindDisclosureGestures(
  trigger: HTMLButtonElement,
  onHoverStart: () => () => void,
  onPressStart: () => () => void,
): () => void {
  const ownerWindow = trigger.ownerDocument.defaultView;
  if (ownerWindow === window) {
    const stopHover = hover(trigger, onHoverStart);
    const stopPress = registerOwnedMotionPress([trigger], onPressStart);
    const stopKeyboard = registerKeyboardPress(trigger, () =>
      trigger.disabled ? undefined : onPressStart(),
    );
    return () => {
      stopHover();
      stopPress();
      stopKeyboard();
    };
  }
  if (ownerWindow === null) return () => undefined;
  let endHover: (() => void) | undefined;
  let endPress: (() => void) | undefined;
  let pointerId: number | undefined;
  const pointerEnter = (event: PointerEvent): void => {
    if (event.pointerType !== "touch" && endHover === undefined) endHover = onHoverStart();
  };
  const pointerLeave = (): void => {
    endHover?.();
    endHover = undefined;
  };
  const pointerEnd = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;
    endPress?.();
    endPress = undefined;
    pointerId = undefined;
  };
  const pointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !event.isPrimary || endPress !== undefined) return;
    pointerId = event.pointerId;
    endPress = onPressStart();
  };
  const blur = (): void => {
    endPress?.();
    endPress = undefined;
    pointerId = undefined;
  };
  const stopKeyboard = registerKeyboardPress(
    trigger,
    () => (trigger.disabled ? undefined : onPressStart()),
    true,
  );
  const onWindowBlur = (): void => {
    pointerLeave();
    blur();
  };
  trigger.addEventListener("pointerenter", pointerEnter);
  trigger.addEventListener("pointerleave", pointerLeave);
  trigger.addEventListener("pointerdown", pointerDown);
  ownerWindow.addEventListener("blur", onWindowBlur);
  ownerWindow.addEventListener("pagehide", onWindowBlur);
  trigger.addEventListener("blur", blur);
  ownerWindow.addEventListener("pointerup", pointerEnd, true);
  ownerWindow.addEventListener("pointercancel", pointerEnd, true);
  return () => {
    trigger.removeEventListener("pointerenter", pointerEnter);
    trigger.removeEventListener("pointerleave", pointerLeave);
    trigger.removeEventListener("pointerdown", pointerDown);
    stopKeyboard();
    ownerWindow.removeEventListener("blur", onWindowBlur);
    ownerWindow.removeEventListener("pagehide", onWindowBlur);
    trigger.removeEventListener("blur", blur);
    ownerWindow.removeEventListener("pointerup", pointerEnd, true);
    ownerWindow.removeEventListener("pointercancel", pointerEnd, true);
    endPress?.();
    endHover?.();
  };
}
