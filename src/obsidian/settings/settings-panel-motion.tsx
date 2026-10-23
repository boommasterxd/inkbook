import { useAnimationControls } from "motion/react";
import { useLayoutEffect, type ComponentProps, type JSX } from "react";
import { observeEffectiveMotion, type ObserveMotion } from "../runtime/effective-motion";
import { motion } from "motion/react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { InkbookDeviceSettingsV2 } from "../../domain/settings";
import { STANDARD_EASING } from "../../rendering/motion/transitions";

export class SettingsPanelMotion {
  readonly #panel: HTMLElement;
  readonly #readMotion: () => InkbookDeviceSettingsV2["motion"];
  readonly #wrapper: HTMLElement;
  readonly #root: Root;
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
    const wrapper = panel.createDiv();
    wrapper.className = "inkbook-settings-motion-panel";
    panel.before(wrapper);
    this.#wrapper = wrapper;
    this.#root = createRoot(wrapper);
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

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#releasePreference();
    this.#root.unmount();
    this.#wrapper.before(this.#panel);
    this.#wrapper.remove();
  }

  #render(instant: boolean): void {
    const expanded = this.#expanded;
    flushSync(() => {
      this.#root.render(
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
