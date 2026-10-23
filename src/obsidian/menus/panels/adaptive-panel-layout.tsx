import { MotionConfig, motion } from "motion/react";
import { useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { STANDARD_EASING } from "../../../rendering/motion/transitions";
import { menuDomWindow } from "../menu-dom";

interface LayoutContentProps {
  readonly grabber: HTMLElement;
  readonly scroll: HTMLElement;
  readonly revision: number;
  readonly update: () => void;
  readonly suppressProjection: boolean;
}

const staticLayout = {
  style: { transform: "none" },
  transformTemplate: () => "none",
};

function LayoutContent({
  grabber,
  scroll,
  revision,
  update,
  suppressProjection,
}: LayoutContentProps) {
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = content.current;
    if (node === null) return;
    if (grabber.parentElement !== node) node.append(grabber);
    if (scroll.parentElement !== node) node.append(scroll);
    update();
  }, [grabber, revision, scroll, update]);
  return (
    <motion.div
      layout="position"
      layoutDependency={revision}
      ref={content}
      {...(suppressProjection ? staticLayout : {})}
    />
  );
}

/** Lets Motion snapshot native menu content around an owned React commit. */
export class AdaptivePanelLayout {
  readonly #root: Root;
  readonly #host: HTMLElement;
  readonly #grabber: HTMLElement;
  readonly #scroll: HTMLElement;
  #revision = 0;
  #disposed = false;
  #suppressProjection = false;

  public constructor(surface: HTMLElement, grabber: HTMLElement, scroll: HTMLElement) {
    this.#grabber = grabber;
    this.#scroll = scroll;
    this.#host = menuDomWindow(surface.ownerDocument, "adaptive panel layout").createDiv();
    surface.append(this.#host);
    this.#root = createRoot(this.#host);
    this.#render(() => undefined, 0);
  }

  public mutate(update: () => void, durationMs: number): void {
    if (this.#disposed) return;
    this.#revision += 1;
    this.#suppressProjection = durationMs === 0;
    this.#render(update, durationMs);
  }

  public finish(): void {
    if (!this.#disposed) this.mutate(() => undefined, 0);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#root.unmount();
    this.#host.remove();
  }

  #render(update: () => void, durationMs: number): void {
    const revision = this.#revision;
    flushSync(() => {
      this.#root.render(
        <MotionConfig transition={{ duration: durationMs / 1000, ease: STANDARD_EASING }}>
          <motion.div
            className="inkbook-adaptive-panel-motion-surface"
            layout
            layoutDependency={revision}
            {...(this.#suppressProjection ? staticLayout : {})}
          >
            <LayoutContent
              grabber={this.#grabber}
              revision={revision}
              scroll={this.#scroll}
              update={update}
              suppressProjection={this.#suppressProjection}
            />
          </motion.div>
        </MotionConfig>,
      );
    });
  }
}
