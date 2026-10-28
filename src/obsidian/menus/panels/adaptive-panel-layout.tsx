import { MotionConfig, motion, useAnimationControls } from "motion/react";
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
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

const ExistingLayer = forwardRef<HTMLElement, { readonly element: HTMLElement }>(
  function ExistingLayer({ element }, ref) {
    useImperativeHandle(ref, () => element, [element]);
    return null;
  },
);
const MotionLayer = motion.create(ExistingLayer);

interface ViewportHeight {
  readonly layer: HTMLElement;
  readonly height: number;
  readonly durationMs: number;
  readonly onComplete: (() => void) | undefined;
}

/** The viewport owns block size; the sheet keeps its independent swipe translation. */
function LayerHeightMotion({ layer, height, durationMs, onComplete }: ViewportHeight) {
  const controls = useAnimationControls();
  useLayoutEffect(() => {
    let current = true;
    const target = { blockSize: `${String(height)}px` };
    if (durationMs === 0) {
      controls.stop();
      controls.set(target);
      // Motion schedules its style render; reduced motion must publish the target immediately.
      layer.style.blockSize = target.blockSize;
      onComplete?.();
    } else {
      void controls.start(target).then(() => {
        if (current) onComplete?.();
      });
    }
    return () => {
      current = false;
      controls.stop();
    };
  }, [controls, durationMs, height, layer, onComplete]);
  return (
    <MotionLayer
      element={layer}
      initial={false}
      animate={controls}
      transition={{ duration: durationMs / 1000, ease: STANDARD_EASING }}
    />
  );
}

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
  #durationMs = 0;
  #viewport: ViewportHeight | undefined;

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
    this.#durationMs = durationMs;
    this.#render(update, durationMs);
  }

  public setViewportHeight(
    layer: HTMLElement,
    height: number,
    durationMs: number,
    onComplete: () => void,
  ): void {
    if (this.#disposed || this.#viewport?.height === height) return;
    const animate = this.#viewport !== undefined && durationMs > 0;
    this.#viewport = {
      layer,
      height,
      durationMs: animate ? durationMs : 0,
      onComplete: animate ? onComplete : undefined,
    };
    this.#render(() => undefined, this.#durationMs);
  }

  public finish(): void {
    if (this.#viewport !== undefined) this.#viewport = { ...this.#viewport, durationMs: 0 };
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
          {this.#viewport === undefined ? null : <LayerHeightMotion {...this.#viewport} />}
        </MotionConfig>,
      );
    });
  }
}
