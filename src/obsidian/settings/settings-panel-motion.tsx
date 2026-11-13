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
  #onCollapsed: (() => void) | undefined;
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
        this.#completeCollapse();
      },
      observeMotion,
    );
  }

  public setExpanded(expanded: boolean, onCollapsed?: () => void): void {
    if (this.#disposed) return;
    if (expanded || expanded !== this.#expanded || onCollapsed !== undefined)
      this.#onCollapsed = expanded ? undefined : onCollapsed;
    const reduced = this.#reducedMotion();
    if (expanded === this.#expanded && !reduced) {
      if (this.#panel.hidden) this.#completeCollapse();
      return;
    }
    this.#expanded = expanded;
    this.#panel.inert = !expanded;
    if (expanded) this.#panel.hidden = false;
    this.#render(reduced);
    if (reduced && !expanded) this.#completeCollapse();
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
    this.#onCollapsed = undefined;
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
          onCollapsed={() => this.#completeCollapse()}
          ref={(node) => {
            if (node !== null && this.#panel.parentElement !== node) node.append(this.#panel);
          }}
        />,
      );
    });
    if (instant) this.#completeCollapse();
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
      this.#completeCollapse();
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
          this.#completeCollapse();
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

  #completeCollapse(): void {
    if (this.#disposed || this.#expanded) return;
    this.#panel.hidden = true;
    const onCollapsed = this.#onCollapsed;
    this.#onCollapsed = undefined;
    onCollapsed?.();
  }
}

function PanelMotion({
  expanded,
  instant,
  onCollapsed,
  ...props
}: {
  readonly expanded: boolean;
  readonly instant: boolean;
  readonly onCollapsed: () => void;
} & ComponentProps<typeof motion.div>): JSX.Element {
  const controls = useAnimationControls();
  useLayoutEffect(() => {
    const target = { height: expanded ? "auto" : 0 };
    let current = true;
    if (instant) {
      controls.stop();
      controls.set(target);
    } else
      void controls.start(target).then(() => {
        if (current && !expanded) onCollapsed();
      });
    return () => {
      current = false;
      controls.stop();
    };
  }, [controls, expanded, instant, onCollapsed]);
  return (
    <motion.div
      {...props}
      animate={controls}
      initial={false}
      transition={{ duration: instant ? 0 : 0.18, ease: STANDARD_EASING }}
    />
  );
}
