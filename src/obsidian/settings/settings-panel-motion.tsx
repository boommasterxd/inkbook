import { useAnimationControls } from "motion/react";
import { useLayoutEffect, type ComponentProps, type JSX } from "react";
import { observeEffectiveMotion, type ObserveMotion } from "../runtime/effective-motion";
import { motion } from "motion/react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { InkbookDeviceSettingsV2 } from "../../domain/settings";
import { STANDARD_EASING } from "../../rendering/motion/transitions";
import { animateOwnedElement } from "../runtime/element-motion";

export class SettingsPanelMotion {
  readonly #panel: HTMLElement;
  readonly #readMotion: () => InkbookDeviceSettingsV2["motion"];
  readonly #wrapper: HTMLElement;
  readonly #root: Root | undefined;
  readonly #nativeContent: HTMLElement | undefined;
  #animation: ReturnType<typeof animateOwnedElement> | undefined;
  readonly #releasePreference: () => void;
  #expanded: boolean;
  #disposed = false;

  public constructor(
    panel: HTMLElement,
    readMotion: () => InkbookDeviceSettingsV2["motion"],
    observeMotion?: ObserveMotion,
  ) {
    this.#panel = panel;
    this.#readMotion = readMotion;
    this.#expanded = !panel.hidden;
    const wrapper = panel.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
    wrapper.className = "inkbook-settings-motion-panel";
    panel.before(wrapper);
    this.#wrapper = wrapper;
    // React Motion's auto-height resolver uses its module's window frame loop.
    // Native Motion keeps a detached Settings window on its own DOM timeline.
    if (panel.ownerDocument.defaultView !== window) {
      const content = panel.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
      content.className = "inkbook-settings-motion-content";
      wrapper.append(content);
      content.append(panel);
      this.#nativeContent = content;
    } else this.#root = createRoot(wrapper);
    this.#render(true);
    this.#releasePreference = observeEffectiveMotion(
      panel,
      readMotion,
      (reduced) => {
        if (!reduced || this.#disposed) return;
        this.#render(true);
        this.#panel.hidden = !this.#expanded;
      },
      observeMotion,
    );
  }

  public setExpanded(expanded: boolean): void {
    if (this.#disposed) return;
    const reduced = this.#reducedMotion();
    if (expanded === this.#expanded && !reduced) return;
    this.#expanded = expanded;
    this.#panel.inert = !expanded;
    if (expanded) this.#panel.hidden = false;
    this.#render(reduced);
    if (reduced && !expanded) this.#panel.hidden = true;
  }

  /** Retarget asynchronous content from the visible height before its intrinsic size changes. */
  public updateContent(update: () => void): void {
    if (this.#disposed) return;
    const content = this.#expanded ? this.#nativeContent : undefined;
    const current = content?.ownerDocument.defaultView?.getComputedStyle(content).height;
    update();
    if (this.#expanded) this.#render(this.#reducedMotion(), current);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#releasePreference();
    this.#animation?.stop();
    this.#animation = undefined;
    this.#root?.unmount();
    this.#wrapper.before(this.#panel);
    this.#wrapper.remove();
  }

  #render(instant: boolean, currentHeight?: string): void {
    if (this.#nativeContent !== undefined) {
      this.#renderNative(instant, currentHeight);
      return;
    }
    const expanded = this.#expanded;
    flushSync(() => {
      this.#root?.render(
        <PanelMotion
          expanded={expanded}
          instant={instant}
          className="inkbook-settings-motion-content"
          onAnimationComplete={() => {
            if (!this.#disposed && !this.#expanded) this.#panel.hidden = true;
          }}
          ref={(node) => {
            if (node !== null && this.#panel.parentElement !== node) node.append(this.#panel);
          }}
        />,
      );
    });
  }

  #renderNative(instant: boolean, currentHeight?: string): void {
    const content = this.#nativeContent;
    const ownerWindow = content?.ownerDocument.defaultView;
    if (content === undefined || ownerWindow === null || ownerWindow === undefined) return;
    const target = this.#expanded ? "auto" : "0px";
    const supported = ownerWindow.CSS.supports("interpolate-size", "allow-keywords");
    const current =
      instant || !supported
        ? target
        : (currentHeight ?? ownerWindow.getComputedStyle(content).height);
    this.#animation?.stop();
    this.#animation = undefined;
    // Older engines settle immediately rather than clipping usable controls forever.
    if (instant || !supported) {
      content.style.height = target;
      this.#panel.hidden = !this.#expanded;
      return;
    }
    const animation = animateOwnedElement(
      content,
      { height: [current, target] },
      {
        duration: 0.18,
        ease: STANDARD_EASING,
        onComplete: () => {
          if (this.#disposed || this.#animation !== animation) return;
          this.#animation = undefined;
          if (!this.#expanded) this.#panel.hidden = true;
        },
      },
    );
    this.#animation = animation;
  }

  #reducedMotion(): boolean {
    const motion = this.#readMotion();
    if (motion !== "system") return motion === "reduced";
    return (
      this.#panel.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)")
        .matches ?? true
    );
  }
}

function PanelMotion({
  expanded,
  instant,
  ...props
}: {
  readonly expanded: boolean;
  readonly instant: boolean;
} & ComponentProps<typeof motion.div>): JSX.Element {
  const controls = useAnimationControls();
  useLayoutEffect(() => {
    const target = { height: expanded ? "auto" : 0 };
    if (instant) {
      controls.stop();
      controls.set(target);
      if (!expanded) props.onAnimationComplete?.(target);
    } else void controls.start(target);
  }, [controls, expanded, instant, props.onAnimationComplete]);
  return (
    <motion.div
      {...props}
      animate={controls}
      initial={false}
      transition={{ duration: instant ? 0 : 0.18, ease: STANDARD_EASING }}
    />
  );
}
