import type { InkbookDeviceSettingsV2 } from "../../domain/settings";
import { MOTION_TOKENS, STANDARD_EASING } from "../../rendering/motion/transitions";
import { observeEffectiveMotion, type ObserveMotion } from "../runtime/effective-motion";
import { animateOwnedElement } from "../runtime/element-motion";

const disclosureDuration = MOTION_TOKENS.standard / 1000;

export class SettingsPanelMotion {
  readonly #wrapper: HTMLElement;
  readonly #content: HTMLElement;
  readonly #releasePreference: () => void;
  #animation: ReturnType<typeof animateOwnedElement> | undefined;
  #expanded: boolean;
  #onCollapsed: (() => void) | undefined;
  #disposed = false;

  public constructor(
    private readonly panel: HTMLElement,
    private readonly readMotion: () => InkbookDeviceSettingsV2["motion"],
    observeMotion?: ObserveMotion,
  ) {
    this.#expanded = !panel.hidden;
    this.#wrapper = panel.ownerDocument.createElement("div");
    this.#wrapper.className = "inkbook-settings-motion-panel";
    this.#content = this.#wrapper.createDiv({ cls: "inkbook-settings-motion-content" });
    panel.before(this.#wrapper);
    this.#content.append(panel);
    this.#showHeight();
    this.#releasePreference = observeEffectiveMotion(
      panel,
      readMotion,
      (reduced) => {
        if (reduced && !this.#disposed) this.#showHeight();
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
      if (this.panel.hidden) this.#completeCollapse();
      return;
    }
    const from = reduced ? undefined : this.#visibleHeight();
    this.#expanded = expanded;
    this.panel.inert = !expanded;
    if (expanded) this.panel.hidden = false;
    this.#showHeight(from);
  }

  /** Keep the outer panel stable across a synchronous content replacement. */
  public updateContent(update: () => void): void {
    if (this.#disposed) return;
    const from = this.#expanded && !this.#reducedMotion() ? this.#visibleHeight() : undefined;
    if (from !== undefined) {
      this.#stop();
      this.#content.setCssProps({ height: from });
    }
    try {
      update();
    } finally {
      if (this.#expanded && !this.#disposed) this.#showHeight(from);
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#onCollapsed = undefined;
    this.#releasePreference();
    this.#stop();
    this.#wrapper.before(this.panel);
    this.#wrapper.remove();
  }

  #showHeight(from?: string): void {
    this.#stop();
    const target = this.#expanded ? "auto" : "0px";
    this.#content.setCssProps({ height: target });
    const to = from === undefined ? undefined : this.#visibleHeight();
    if (from === undefined || to === undefined || from === to) {
      this.#completeCollapse();
      return;
    }
    // Measure and restore the starting height before the browser can paint the new layout.
    this.#content.setCssProps({ height: from });
    const animation = animateOwnedElement(
      this.#content,
      { height: [from, to] },
      {
        duration: disclosureDuration,
        ease: STANDARD_EASING,
        onComplete: () => {
          if (this.#animation !== animation) return;
          this.#animation = undefined;
          this.#content.setCssProps({ height: target });
          this.#completeCollapse();
        },
      },
    );
    this.#animation = animation;
  }

  #visibleHeight(): string | undefined {
    const content = this.#content;
    if (!content.isConnected || typeof content.animate !== "function") return undefined;
    const height = content.ownerDocument.defaultView?.getComputedStyle(content).height;
    return height?.endsWith("px") === true ? height : undefined;
  }

  #stop(): void {
    const animation = this.#animation;
    this.#animation = undefined;
    animation?.stop();
  }

  #reducedMotion(): boolean {
    const motion = this.readMotion();
    if (motion !== "system") return motion === "reduced";
    return (
      this.panel.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)")
        .matches ?? true
    );
  }

  #completeCollapse(): void {
    if (this.#disposed || this.#expanded) return;
    this.panel.hidden = true;
    const onCollapsed = this.#onCollapsed;
    this.#onCollapsed = undefined;
    onCollapsed?.();
  }
}
