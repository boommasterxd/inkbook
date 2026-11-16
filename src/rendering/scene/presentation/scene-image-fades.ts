import { cubicBezier, mix } from "motion";
import { ERASE_EASING } from "../../motion/transitions";
import { clearImageOpacity, writeImageOpacity } from "../content/image-opacity";
import {
  setElementFadeNode,
  type ElementFadePresentation,
  type ImageFadeFactory,
  type FadePlaybackControls,
} from "./element-fade-style";
import type { PendingElementFade } from "./scene-motion-types";

const ease = cubicBezier(...ERASE_EASING);
interface ImageFade {
  readonly node: SVGElement;
  readonly from: string;
  readonly to: string;
  readonly start: number;
  readonly duration: number;
  readonly now: () => number;
}

/** Authored inline opacity is shared by the real image and every SVG use instance. */
export class SceneImageFades {
  readonly #active = new Map<SVGElement, ImageFade>();
  #cursor: MapIterator<[SVGElement, ImageFade]> | undefined;
  #now: () => number = () => 0;
  #interruptedThrough = -1;
  readonly #factory: ImageFadeFactory = (node, frames, duration) =>
    node.getAttribute("data-inkbook-image") === null
      ? undefined
      : this.start(node, frames, duration);

  public get pending(): boolean {
    return this.#active.size !== 0;
  }

  public interrupt(generation: number): void {
    this.#interruptedThrough = Math.max(this.#interruptedThrough, generation);
  }

  public apply(
    node: SVGElement,
    duration: number,
    presentation: ElementFadePresentation,
    fade: Pick<PendingElementFade, "direction" | "generation">,
    now: () => number,
  ): void {
    this.#now = now;
    setElementFadeNode(
      node,
      duration,
      presentation,
      fade.direction,
      fade.generation,
      this.#factory,
    );
  }

  public advance(deadline: number, now: () => number): void {
    const cursor = (this.#cursor ??= this.#active.entries());
    let visited = false;
    while (!visited || now() < deadline) {
      const next = cursor.next();
      if (next.done) {
        this.#cursor = undefined;
        return;
      }
      const [node, entry] = next.value;
      if (this.#active.get(node) !== entry) continue;
      this.render(entry, now());
      visited = true;
    }
  }

  public release(): void {
    for (const entry of this.#active.values()) clearImageOpacity(entry.node);
    this.#active.clear();
    this.#cursor = undefined;
  }

  public memoryUsage(): number {
    return this.#active.size * 192 + (this.#cursor === undefined ? 0 : 16);
  }

  private start(
    node: SVGElement,
    frames: readonly string[],
    duration: number,
  ): FadePlaybackControls {
    const entry: ImageFade = {
      node,
      from: frames[0]!,
      to: frames[1]!,
      duration,
      start: this.#now(),
      now: this.#now,
    };
    this.#active.set(node, entry);
    writeImageOpacity(node, entry.from);
    return {
      stop: () => {
        if (this.#active.has(node) && this.#active.get(node) !== entry) return;
        const progress = this.progress(entry, entry.now());
        const opacity = mix(this.endpoint(entry.from), this.endpoint(entry.to), progress);
        writeImageOpacity(node, String(Math.round(opacity * 1e6) / 1e6));
        this.remove(entry);
      },
      cancel: () => {
        if (this.#active.has(node) && this.#active.get(node) !== entry) return;
        this.remove(entry);
        clearImageOpacity(node);
      },
    };
  }

  private render(entry: ImageFade, now: number): void {
    const progress = Math.max(0, Math.min(1, (now - entry.start) / entry.duration));
    const value = this.progress(entry, now);
    const opacity =
      progress === 0
        ? entry.from
        : progress === 1
          ? entry.to
          : `calc(${entry.from} * ${1 - value} + ${entry.to} * ${value})`;
    writeImageOpacity(entry.node, opacity);
    if (progress === 1) this.remove(entry);
  }

  private progress(entry: ImageFade, now: number): number {
    return ease(Math.max(0, Math.min(1, (now - entry.start) / entry.duration)));
  }

  private endpoint(value: string): number {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const generation = /--inkbook-history-active-(\d+)/.exec(value);
    const base = /^calc\(([-+\d.eE]+)/.exec(value);
    return generation !== null && Number(generation[1]) <= this.#interruptedThrough
      ? Number(base?.[1] ?? 1)
      : 0;
  }

  private remove(entry: ImageFade): void {
    this.#active.delete(entry.node);
    if (this.#active.size === 0) this.#cursor = undefined;
  }
}
