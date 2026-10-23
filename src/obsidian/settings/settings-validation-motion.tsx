import { AnimatePresence, LayoutGroup, motion, MotionConfig } from "motion/react";
import { createPortal, flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";

import { getTransitionDuration, STANDARD_EASING } from "../../rendering/motion/transitions";
import type { NativeControlFeedbackOptions } from "../menus/feedback/native-control-feedback";
import { observeEffectiveMotion } from "../runtime/effective-motion";
import {
  ExistingSettingsMotion,
  guardCanceledSettingsAnimations,
  restoreSettingsMotionBoundaries,
  settingsMotionBoundaries,
  type SettingsMotionBoundary,
} from "./settings-motion-boundary";

const GROUP_SELECTOR = ".inkbook-settings-page-group, .inkbook-settings-tool-group";
const BOUNDARY_SELECTOR = `${GROUP_SELECTOR}, .setting-item, .inkbook-settings-visual-row, .inkbook-settings-tool-section, .inkbook-settings-tool-controls, .inkbook-menu-controls, .inkbook-menu-control`;
const owners = new WeakMap<HTMLElement, SettingsValidationMotion>();

/** Shares one projection owner for validation rows and their following native settings. */
export function createSettingsValidationMotion(
  container: HTMLElement,
  options: NativeControlFeedbackOptions,
): { set: (error: HTMLElement, message: string) => void; dispose: () => void } {
  const scope =
    container.closest<HTMLElement>(GROUP_SELECTOR) ?? container.parentElement ?? container;
  let owner = owners.get(scope);
  if (owner === undefined) {
    owner = new SettingsValidationMotion(scope, options);
    owners.set(scope, owner);
  }
  const errors = new Set<HTMLElement>();
  const shared = owner;
  let disposed = false;
  shared.retain();
  return {
    set: (error, message) => {
      if (disposed) return;
      errors.add(error);
      shared.set(error, message);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (shared.release(errors)) owners.delete(scope);
    },
  };
}

class SettingsValidationMotion {
  readonly #scope: HTMLElement;
  readonly #messages = new Map<HTMLElement, string>();
  readonly #unsubscribe: () => void;
  #root: Root | undefined;
  #host: HTMLElement | undefined;
  #boundaries: SettingsMotionBoundary[] = [];
  #reduced = false;
  #references = 0;

  public constructor(scope: HTMLElement, options: NativeControlFeedbackOptions) {
    this.#scope = scope;
    this.#unsubscribe = observeEffectiveMotion(
      scope,
      options.readMotion,
      (reduced) => {
        this.#reduced = reduced;
        if (reduced) this.#finish();
      },
      options.observeMotion,
    );
  }

  public retain(): void {
    this.#references += 1;
  }

  public set(error: HTMLElement, message: string): void {
    if (!this.#messages.has(error)) this.#messages.set(error, "");
    if (!this.#reduced && message !== "") this.#ensureRoot();
    error.classList.add("inkbook-menu-visually-hidden");
    error.textContent = message;
    error.hidden = message === "";
    this.#messages.set(error, message);
    if (this.#reduced || this.#root === undefined) this.#settle();
    else this.#render();
  }

  public release(errors: ReadonlySet<HTMLElement>): boolean {
    for (const error of errors) {
      error.parentElement?.querySelector(`[data-validation-for="${error.id}"]`)?.remove();
      this.#messages.delete(error);
    }
    this.#references -= 1;
    if (this.#references > 0) {
      this.#render();
      return false;
    }
    this.#finish();
    this.#unsubscribe();
    return true;
  }

  #ensureRoot(): void {
    if (this.#root !== undefined) {
      this.#boundaries = settingsMotionBoundaries(this.#scope, BOUNDARY_SELECTOR, this.#boundaries);
      this.#render();
      return;
    }
    for (const error of this.#messages.keys()) {
      error.parentElement?.querySelector(`[data-validation-for="${error.id}"]`)?.remove();
    }
    this.#boundaries = settingsMotionBoundaries(this.#scope, BOUNDARY_SELECTOR);
    this.#host = this.#scope.createDiv();
    this.#host.hidden = true;
    this.#root = createRoot(this.#host);
    this.#render();
  }

  #render(): void {
    if (this.#root === undefined) return;
    guardCanceledSettingsAnimations(this.#scope);
    const duration = getTransitionDuration("fallback", this.#reduced) / 1000;
    flushSync(() => {
      this.#root?.render(
        <MotionConfig transition={{ duration, ease: STANDARD_EASING }}>
          <LayoutGroup>{this.#boundaries.map((boundary) => this.#boundary(boundary))}</LayoutGroup>
        </MotionConfig>,
      );
    });
    guardCanceledSettingsAnimations(this.#scope);
  }

  #boundary(boundary: SettingsMotionBoundary): ReactNode {
    return (
      <ExistingSettingsMotion element={boundary.element} key={boundary.key} layout>
        {boundary.children.map((child) => this.#boundary(child))}
        {[...this.#messages].map(([error, message]) =>
          error.parentElement === boundary.element ? this.#visual(error, message) : null,
        )}
      </ExistingSettingsMotion>
    );
  }

  #visual(error: HTMLElement, message: string): ReactNode {
    if (error.parentElement === null) return null;
    return createPortal(
      <AnimatePresence initial={false} mode="popLayout" root={error.ownerDocument.head}>
        {message === "" ? null : (
          <motion.div
            animate={{ opacity: 1 }}
            aria-hidden="true"
            className="inkbook-settings-validation-visual"
            exit={{ opacity: 0 }}
            inert
            initial={{ opacity: 0 }}
            key={message}
            layout
          >
            {message}
          </motion.div>
        )}
      </AnimatePresence>,
      error.parentElement,
      error.id,
    );
  }

  #finish(): void {
    guardCanceledSettingsAnimations(this.#scope);
    this.#root?.unmount();
    this.#host?.remove();
    restoreSettingsMotionBoundaries(this.#boundaries);
    this.#root = undefined;
    this.#host = undefined;
    this.#boundaries = [];
    this.#settle();
  }

  #settle(): void {
    for (const [error, message] of this.#messages) {
      let visual = error.parentElement?.querySelector<HTMLElement>(
        `[data-validation-for="${error.id}"]`,
      );
      if (message === "") visual?.remove();
      else {
        visual ??= error.parentElement?.createDiv({ cls: "inkbook-settings-validation-visual" });
        if (visual === undefined) continue;
        visual.dataset.validationFor = error.id;
        visual.setAttribute("aria-hidden", "true");
        visual.inert = true;
        visual.textContent = message;
      }
    }
  }
}
