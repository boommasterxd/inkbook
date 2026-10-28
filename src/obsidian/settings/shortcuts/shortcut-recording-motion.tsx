import { AnimatePresence, LayoutGroup, motion, MotionConfig, useIsPresent } from "motion/react";
import { forwardRef, type ForwardedRef, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import {
  getTransitionDuration,
  isReducedMotion,
  STANDARD_EASING,
  type MotionPreference,
} from "../../../rendering/motion/transitions";
import { menuDomWindow } from "../../menus/menu-dom";
import {
  ExistingSettingsMotion,
  guardCanceledSettingsAnimations,
  restoreSettingsMotionBoundaries,
  settingsMotionBoundaries,
  type SettingsMotionBoundary,
} from "../settings-motion-boundary";

interface ShortcutContent {
  readonly key: string;
  readonly nodes: readonly Node[];
}

const BOUNDARY_SELECTOR =
  ".inkbook-shortcut-section, .setting-item, .setting-item-info, .setting-item-control, .inkbook-shortcut-recorder, .inkbook-shortcut-status";

const Content = forwardRef(function Content(
  { content }: { content: ShortcutContent },
  ref: ForwardedRef<HTMLSpanElement>,
) {
  const present = useIsPresent();
  return (
    <motion.span
      animate={{ opacity: 1 }}
      aria-hidden={present ? undefined : true}
      className="inkbook-shortcut-transition-content"
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      inert={!present}
      layout="position"
      ref={(node) => {
        if (node !== null) node.replaceChildren(...content.nodes);
        if (typeof ref === "function") ref(node);
        else if (ref !== null) ref.current = node;
      }}
    />
  );
});

/** Projects native recorder surfaces and their following settings without replacing DOM or focus. */
export class ShortcutRecordingMotion {
  readonly #container: HTMLElement;
  readonly #readMotion: () => MotionPreference;
  readonly #contents = new Map<HTMLElement, ShortcutContent>();
  readonly #query: MediaQueryList | undefined;
  #root: Root | undefined;
  #host: HTMLElement | undefined;
  #boundaries: SettingsMotionBoundary[] = [];

  public constructor(root: HTMLElement, readMotion: () => MotionPreference) {
    this.#container = root;
    this.#readMotion = readMotion;
    this.#query = root.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)");
    this.#query?.addEventListener("change", this.#finishReduced);
  }

  public replace(element: HTMLElement, render: (content: HTMLElement) => void): void {
    this.#ensureRoot();
    if (!this.#contents.has(element)) {
      this.#contents.set(element, this.#content(element, [...element.childNodes]));
      this.#render();
    }
    const content = menuDomWindow(element.ownerDocument, "shortcut content").createSpan();
    render(content);
    this.#contents.set(element, this.#content(element, [...content.childNodes]));
    this.#render();
  }

  public finish(): void {
    guardCanceledSettingsAnimations(this.#container);
    this.#root?.unmount();
    for (const [element, content] of this.#contents) element.replaceChildren(...content.nodes);
    this.#host?.remove();
    restoreSettingsMotionBoundaries(this.#boundaries);
    this.#root = undefined;
    this.#host = undefined;
    this.#boundaries = [];
    this.#contents.clear();
  }

  public dispose(): void {
    this.finish();
    this.#query?.removeEventListener("change", this.#finishReduced);
  }

  public finishReduced(): void {
    this.#finishReduced();
  }

  #ensureRoot(): void {
    if (this.#root !== undefined) return;
    this.#boundaries = settingsMotionBoundaries(this.#container, BOUNDARY_SELECTOR);
    this.#host = this.#container.createDiv();
    this.#host.hidden = true;
    this.#root = createRoot(this.#host);
    this.#render();
  }

  #content(element: HTMLElement, nodes: readonly Node[]): ShortcutContent {
    const error = element.classList.contains("is-error");
    return {
      key: `${nodes.map((node) => node.textContent).join("")}:${String(error)}`,
      nodes,
    };
  }

  #render(): void {
    const reduced = isReducedMotion(this.#readMotion(), this.#query?.matches);
    const duration = getTransitionDuration("toolActiveState", reduced) / 1000;
    guardCanceledSettingsAnimations(this.#container);
    flushSync(() => {
      this.#root?.render(
        <MotionConfig
          reducedMotion={reduced ? "always" : "never"}
          transition={{ duration, ease: STANDARD_EASING }}
        >
          <LayoutGroup>
            {this.#boundaries.map((boundary) => this.#renderBoundary(boundary))}
          </LayoutGroup>
        </MotionConfig>,
      );
    });
    guardCanceledSettingsAnimations(this.#container);
  }

  #renderBoundary(boundary: SettingsMotionBoundary): ReactNode {
    const { element, children, key } = boundary;
    const content = this.#contents.get(element);
    return (
      <ExistingSettingsMotion
        element={element}
        key={key}
        layout={
          element.matches(".setting-item-info, .setting-item-control, .inkbook-shortcut-section")
            ? "position"
            : true
        }
      >
        {children.map((child) => this.#renderBoundary(child))}
        {content === undefined
          ? null
          : createPortal(
              <motion.span className="inkbook-shortcut-transition" layout="size">
                <AnimatePresence initial={false} mode="popLayout" root={element.ownerDocument.head}>
                  <Content content={content} key={content.key} />
                </AnimatePresence>
              </motion.span>,
              element,
            )}
      </ExistingSettingsMotion>
    );
  }

  readonly #finishReduced = (): void => {
    if (isReducedMotion(this.#readMotion(), this.#query?.matches)) this.finish();
  };
}
