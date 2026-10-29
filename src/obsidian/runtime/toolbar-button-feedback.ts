import {
  toolbarButtonFeedback,
  toolbarButtonFeedbackTransition,
} from "../../rendering/motion/toolbar-button-feedback";
import { bindOwnerGestures } from "../../rendering/motion/toolbar-owner-gestures";
import { createChromePalette, type ChromeColors } from "../../rendering/ui/chrome-palette";
import { animateOwnedElement } from "./element-motion";
import { observeEffectiveMotion } from "./effective-motion";

interface ButtonFeedback {
  readonly render: () => void;
  readonly refresh: () => void;
  readonly dispose: () => void;
}

/** Reuses toolbar surface feedback without changing native button semantics or hit areas. */
export function mountToolbarButtonFeedback(container: HTMLElement, motionRoot: HTMLElement) {
  const ownerWindow = container.ownerDocument.defaultView!;
  const palette = createChromePalette(container);
  let colors = palette.read();
  let reduced = false;
  let disposed = false;
  const buttons: ButtonFeedback[] = [];
  const render = (): void => {
    for (const button of buttons) button.render();
  };
  const stopPreference = observeEffectiveMotion(motionRoot, undefined, (value) => {
    reduced = value;
    render();
  });
  for (const button of container.querySelectorAll<HTMLButtonElement>("button")) {
    const surface = button.querySelector<HTMLElement>(".inkbook-toolbar-button-surface");
    if (surface !== null)
      buttons.push(mountButtonFeedback(button, surface, () => ({ colors, reduced })));
  }
  const observer = new ownerWindow.MutationObserver(() => {
    colors = palette.read();
    render();
  });
  observer.observe(motionRoot, {
    attributes: true,
    attributeFilter: ["data-inkbook-scheme"],
  });
  for (const target of [ownerWindow.document.documentElement, ownerWindow.document.body])
    observer.observe(target, { attributes: true, attributeFilter: ["class", "style"] });
  return {
    refresh: (): void => {
      if (!disposed) for (const button of buttons) button.refresh();
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      stopPreference();
      for (const button of buttons) button.dispose();
      palette.dispose();
    },
  };
}

function mountButtonFeedback(
  button: HTMLButtonElement,
  surface: HTMLElement,
  read: () => { colors: ChromeColors | undefined; reduced: boolean },
): ButtonFeedback {
  let gesture = "rest";
  let hovering = false;
  let disposed = false;
  let disabled = button.disabled;
  let animation: ReturnType<typeof animateOwnedElement> | undefined;
  const render = (): void => {
    if (disposed) return;
    const { colors, reduced } = read();
    const feedback = toolbarButtonFeedback(colors);
    const state = {
      ...feedback.rest,
      ...(!button.disabled && hovering ? feedback.hover : {}),
      ...(!button.disabled && gesture === "press" ? feedback.press : {}),
    };
    const targets = {
      backgroundColor: state["--inkbook-toolbar-background"],
      borderColor: state["--inkbook-toolbar-border"],
      scale: state.scale,
    };
    animation?.stop();
    animation = undefined;
    if (reduced || button.disabled || typeof surface.animate !== "function") {
      surface.style.backgroundColor = targets.backgroundColor;
      surface.style.borderColor = targets.borderColor;
      surface.style.scale = String(targets.scale);
      return;
    }
    animation = animateOwnedElement(surface, targets, toolbarButtonFeedbackTransition(reduced));
    void animation.finished.catch(() => undefined);
  };
  const bind = (): (() => void) | undefined =>
    bindOwnerGestures(
      button,
      disabled,
      (state) => {
        gesture = state.gesture;
        hovering = state.hovering;
        render();
      },
      true,
    );
  let stopGestures = bind();
  return {
    render,
    refresh: () => {
      if (disabled === button.disabled) return;
      stopGestures?.();
      disabled = button.disabled;
      stopGestures = bind();
    },
    dispose: () => {
      disposed = true;
      stopGestures?.();
      animation?.cancel();
      for (const name of ["scale", "background-color", "border-color"])
        surface.style.removeProperty(name);
    },
  };
}
