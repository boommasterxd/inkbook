import { setMountedElementFade, type MountedSceneElement } from "./mounted-element";
import {
  elementFadePresentation,
  elementFadeTarget,
  elementFadeTargetCount,
  setElementFadeNode,
} from "./element-fade-style";
import type { ElementFadeMode } from "../motion/transitions";

const FADE_NODES_PER_FRAME = 128;

export interface FadeSlice {
  readonly deadline: number;
  readonly now: () => number;
}

interface PendingFade {
  readonly durationMs: number;
  readonly mode: ElementFadeMode;
  index: number;
}

/** Starts element feedback in bounded batches without truncating queued exits. */
export class SceneElementFades {
  readonly #pending = new Map<string, PendingFade>();
  readonly #finishes = new Map<string, number>();
  #remaining = FADE_NODES_PER_FRAME;
  #initialDeadline: number | undefined;

  public constructor(
    private readonly mounted: ReadonlyMap<string, MountedSceneElement>,
    private readonly onReadinessChanged?: (id: string, finish: number) => void,
  ) {}

  public set(
    ids: readonly string[],
    durationMs: number | null,
    slice?: FadeSlice,
    mode: ElementFadeMode = "blur",
  ): void {
    for (const id of ids) {
      if (durationMs === null) {
        this.#pending.delete(id);
        this.#finishes.delete(id);
        this.onReadinessChanged?.(id, 0);
        const entry = this.mounted.get(id);
        if (entry?.fadeActive === true) setMountedElementFade(entry, null);
      } else if (!this.#pending.has(id) && !this.#finishes.has(id) && this.mounted.has(id)) {
        this.#pending.set(id, { durationMs, mode, index: 0 });
        this.onReadinessChanged?.(id, Infinity);
      }
    }
    if (durationMs !== null && slice !== undefined) {
      this.#initialDeadline = Math.min(this.#initialDeadline ?? slice.deadline, slice.deadline);
      this.write(this.#initialDeadline, slice.now);
    }
  }

  public get pending(): boolean {
    return this.#pending.size > 0;
  }

  public flush(deadline: number, now: () => number): boolean {
    this.write(deadline, now);
    this.#remaining = FADE_NODES_PER_FRAME;
    this.#initialDeadline = undefined;
    return this.pending;
  }

  public isExitReady(id: string, now: number): boolean {
    if (this.#pending.has(id)) return false;
    const finish = this.#finishes.get(id);
    if (finish !== undefined && now < finish) return false;
    this.#finishes.delete(id);
    return true;
  }

  public readyAt(id: string): number {
    return this.#pending.has(id) ? Infinity : (this.#finishes.get(id) ?? 0);
  }

  public release(): void {
    this.#pending.clear();
    this.#finishes.clear();
  }

  private write(deadline: number, now: () => number): void {
    for (const [id, fade] of this.#pending) {
      if (this.#remaining <= 0 || (this.#remaining < FADE_NODES_PER_FRAME && now() >= deadline))
        break;
      const entry = this.mounted.get(id);
      if (entry === undefined) {
        this.#pending.delete(id);
        this.#finishes.delete(id);
        this.onReadinessChanged?.(id, 0);
        this.#remaining -= 1;
        continue;
      }
      if (fade.index === 0) {
        const presentation = elementFadePresentation(entry, fade.mode);
        if (entry.fadeActive && entry.fadePresentation !== presentation)
          setMountedElementFade(entry, null);
        entry.fadePresentation = presentation;
      }
      entry.fadeActive = true;
      const presentation = entry.fadePresentation!;
      const count = elementFadeTargetCount(entry, presentation);
      do {
        const node = elementFadeTarget(entry, fade.index, presentation);
        if (node !== undefined)
          setElementFadeNode(node, fade.durationMs, entry.displayedElement, presentation);
        fade.index += 1;
        this.#remaining -= 1;
        this.#finishes.set(id, now() + fade.durationMs);
      } while (fade.index < count && this.#remaining > 0 && now() < deadline);
      if (fade.index < count) break;
      this.#pending.delete(id);
      this.onReadinessChanged?.(id, this.#finishes.get(id) ?? 0);
    }
  }
}
