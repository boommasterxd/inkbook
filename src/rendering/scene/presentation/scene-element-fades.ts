import {
  setMountedElementFade,
  setMountedElementMotion,
  type MountedSceneElement,
} from "../content/mounted-element";
import type { Bounds } from "../../../domain/geometry/primitives";
import { intersects } from "../visibility/visibility-bounds";
import type { PendingElementFade as PendingFade } from "./scene-motion-types";
import {
  elementFadePresentation,
  elementFadeTarget,
  elementFadeTargetCount,
  hideElementFadeRoots,
  setElementFadeNode,
  showElementFadeRoots,
  type ElementFadeDirection,
} from "./element-fade-style";

const FADE_NODES_PER_FRAME = 128;

export interface FadeSlice {
  readonly deadline: number;
  readonly now: () => number;
}

interface EntranceFinish {
  readonly finish: number;
  index: number;
}

/** Starts element feedback in bounded batches without truncating queued exits. */
export class SceneElementFades {
  readonly #pending = new Map<string, PendingFade>();
  readonly #visibleMemberships = new Map<string, PendingFade>();
  readonly #finishes = new Map<string, PendingFade>();
  #reducedMotion = false;
  #exitVersion = 0;
  #reducedThrough = -1;
  #settlingExits: MapIterator<[string, PendingFade]> | undefined;
  readonly #entrances = new Map<string, PendingFade>();
  readonly #entranceFinishes = new Map<string, EntranceFinish>();
  readonly #memberships = new Map<
    string,
    { direction: ElementFadeDirection; generation: number }
  >();
  readonly #generations = new Map<number, number>();
  readonly #styledGenerations = new Map<
    string,
    { targets: Array<number | undefined>; count: number }
  >();
  #styledGenerationCount = 0;
  #generation = 0;
  #interruptedThrough = -1;
  #prune:
    { ids: MapIterator<[string, PendingFade]>; contains: (id: string) => boolean } | undefined;
  #remaining = FADE_NODES_PER_FRAME;
  #initialDeadline: number | undefined;
  #viewport: Bounds | undefined;

  public constructor(
    private readonly mounted: ReadonlyMap<string, MountedSceneElement>,
    private readonly onReadinessChanged?: (id: string, finish: number) => void,
    private readonly membershipGate?: (generation: number, interrupted: boolean) => void,
  ) {}

  public setViewport(bounds: Bounds | undefined): void {
    this.#viewport = bounds;
  }
  public setReducedMotion(reduced: boolean): void {
    if (this.#reducedMotion === reduced) return;
    this.#reducedMotion = reduced;
    if (reduced) {
      this.#reducedThrough = this.#exitVersion;
      this.#settlingExits = this.#finishes.entries();
    }
  }
  public set(ids: readonly string[], durationMs: number | null, slice?: FadeSlice): void {
    for (const id of ids) {
      if (durationMs === null) {
        this.deletePending(id);
        this.#finishes.delete(id);
        this.#entrances.delete(id);
        this.#entranceFinishes.delete(id);
        this.releaseMembership(id);
        this.onReadinessChanged?.(id, 0);
        const entry = this.mounted.get(id);
        if (entry !== undefined) {
          showElementFadeRoots(entry);
          if (entry.fadeActive) setMountedElementFade(entry, null);
        }
        this.releaseStyledGenerations(id);
      } else {
        if (this.#memberships.get(id)?.direction === "enter") {
          this.deletePending(id);
          this.#entrances.delete(id);
          this.#entranceFinishes.delete(id);
          this.releaseMembership(id);
        }
        if (!this.#pending.has(id) && !this.#finishes.has(id) && this.mounted.has(id)) {
          this.#pending.set(id, {
            durationMs: this.#reducedMotion ? 0 : durationMs,
            direction: "exit",
            exitVersion: ++this.#exitVersion,
            index: 0,
          });
          this.onReadinessChanged?.(id, Infinity);
        }
      }
    }
    if (durationMs !== null && slice !== undefined) {
      this.#initialDeadline = Math.min(this.#initialDeadline ?? slice.deadline, slice.deadline);
      this.write(this.#initialDeadline, slice.now);
    }
  }
  public get pending(): boolean {
    return (
      this.#pending.size + this.#entranceFinishes.size > 0 ||
      this.#settlingExits !== undefined ||
      this.#prune !== undefined
    );
  }
  public memoryUsage(): number {
    return (
      (this.#pending.size + this.#entrances.size + this.#entranceFinishes.size) * 64 +
      (this.#memberships.size + this.#finishes.size + this.#generations.size) * 48 +
      this.#finishes.size * 64 + // Retained PendingFade records, including shared partial exits.
      this.#styledGenerations.size * 40 +
      this.#styledGenerationCount * 32 +
      this.#visibleMemberships.size * 32 +
      (this.#settlingExits === undefined ? 0 : 64) +
      (this.#prune === undefined ? 0 : 64)
    );
  }
  public setMembership(
    id: string,
    direction: ElementFadeDirection,
    durationMs: number,
    bounds?: Bounds,
  ): void {
    this.deletePending(id);
    this.#finishes.delete(id);
    this.#entrances.delete(id);
    this.#entranceFinishes.delete(id);
    this.releaseMembership(id);
    this.#prune = undefined;
    const entry = this.mounted.get(id);
    const effectiveBounds = entry?.motionActive === true ? undefined : bounds;
    if (entry !== undefined) setMountedElementMotion(entry, null);
    if (entry === undefined && (direction === "exit" || durationMs === 0)) return;
    const visible = this.membershipVisible(effectiveBounds, entry);
    if (
      !visible &&
      direction === "enter" &&
      entry?.fadeActive !== true &&
      !this.#styledGenerations.has(id)
    ) {
      this.onReadinessChanged?.(id, 0);
      return;
    }
    this.#memberships.set(id, { direction, generation: this.#generation });
    this.#generations.set(this.#generation, (this.#generations.get(this.#generation) ?? 0) + 1);
    const fade = {
      ...(effectiveBounds === undefined ? {} : { bounds: effectiveBounds }),
      durationMs: direction === "exit" || visible ? durationMs : 0,
      direction,
      generation: this.#generation,
      index: 0,
    };
    if (entry === undefined) {
      this.#entrances.set(id, fade);
      return;
    }
    this.queueMembership(id, fade, visible);
    this.onReadinessChanged?.(id, direction === "exit" ? Infinity : 0);
  }
  public bindMounted(entry: MountedSceneElement): void {
    const fade = this.#entrances.get(entry.id);
    if (fade === undefined) return;
    this.#entrances.delete(entry.id);
    if (!this.membershipVisible(fade.bounds, entry)) {
      this.releaseMembership(entry.id);
      return;
    }
    if (!this.interrupted(entry.id))
      hideElementFadeRoots(entry, fade.generation!, (index) =>
        this.writeStyledGeneration(entry.id, index, fade.generation),
      );
    this.queueMembership(entry.id, fade, true);
  }
  public interruptMembership(): void {
    if (!this.#generations.has(this.#generation)) return;
    this.membershipGate?.(this.#generation, true);
    this.#interruptedThrough = this.#generation;
    this.#generation += 1;
  }
  public settleVisibility(contains: (id: string) => boolean): void {
    if (this.#entrances.size > 0) this.#prune = { ids: this.#entrances.entries(), contains };
  }
  public flush(deadline: number, now: () => number): boolean {
    this.settleExits(deadline, now);
    this.write(deadline, now);
    this.cleanupEntrances(deadline, now);
    this.pruneEntrances(deadline, now);
    this.#remaining = FADE_NODES_PER_FRAME;
    this.#initialDeadline = undefined;
    return this.pending;
  }
  public isExitReady(id: string, now: number): boolean {
    if (this.interrupted(id)) {
      if (this.#memberships.get(id)?.direction === "exit") {
        this.deletePending(id);
        this.#finishes.delete(id);
      }
      return true;
    }
    if (this.#pending.get(id)?.direction === "exit") return false;
    const finish = this.#finishes.get(id)?.finish;
    if (finish !== undefined && now < finish) return false;
    this.#finishes.delete(id);
    return true;
  }
  public releaseMounted(id: string): void {
    this.deletePending(id);
    this.#finishes.delete(id);
    this.#entranceFinishes.delete(id);
    this.releaseMembership(id);
    this.releaseStyledGenerations(id);
  }
  public readyAt(id: string): number {
    if (this.interrupted(id)) return 0;
    return this.#pending.get(id)?.direction === "exit"
      ? Infinity
      : (this.#finishes.get(id)?.finish ?? 0);
  }
  public release(): void {
    for (const entry of this.mounted.values())
      if (entry.fadeActive) setMountedElementFade(entry, null);
    this.#pending.clear();
    this.#visibleMemberships.clear();
    this.#finishes.clear();
    this.#settlingExits = undefined;
    this.#entrances.clear();
    this.#entranceFinishes.clear();
    this.#prune = undefined;
    for (const generation of this.#generations.keys()) this.membershipGate?.(generation, false);
    this.#generations.clear();
    this.#memberships.clear();
    this.#styledGenerations.clear();
    this.#styledGenerationCount = 0;
  }
  private write(deadline: number, now: () => number): void {
    const visited = this.writeQueue(this.#visibleMemberships, deadline, now);
    if (!visited || now() < deadline) this.writeQueue(this.#pending, deadline, now);
  }
  private settleExits(deadline: number, now: () => number): void {
    const exits = this.#settlingExits;
    if (exits === undefined) return;
    let visited = false;
    while (this.#remaining > 0 && (!visited || now() < deadline)) {
      const next = exits.next();
      if (next.done) {
        this.#settlingExits = undefined;
        return;
      }
      visited = true;
      const [id, fade] = next.value;
      const { exitVersion } = fade;
      if (exitVersion === undefined || exitVersion > this.#reducedThrough) continue;
      const entry = this.mounted.get(id);
      if (entry === undefined) continue;
      fade.index = 0;
      fade.admittedDurationMs = 0;
      this.#pending.set(id, fade);
      if (!this.writeFade(entry, fade, deadline, now)) return;
      this.deletePending(id);
      this.onReadinessChanged?.(id, this.#finishes.get(id)?.finish ?? 0);
    }
  }
  private writeQueue(
    queue: ReadonlyMap<string, PendingFade>,
    deadline: number,
    now: () => number,
  ): boolean {
    let visited = false;
    for (const [id, fade] of queue) {
      if (
        this.#remaining <= 0 ||
        ((visited || this.#remaining < FADE_NODES_PER_FRAME) && now() >= deadline)
      )
        break;
      visited = true;
      const entry = this.mounted.get(id);
      if (entry === undefined) {
        this.deletePending(id);
        this.#finishes.delete(id);
        this.onReadinessChanged?.(id, 0);
        this.releaseMembership(id);
        this.releaseStyledGenerations(id);
        this.#remaining -= 1;
        continue;
      }
      if (
        queue === this.#visibleMemberships &&
        fade.admittedDurationMs === undefined &&
        !this.membershipVisible(fade.bounds, entry)
      ) {
        this.#visibleMemberships.delete(id);
        continue;
      }
      if (!this.writeFade(entry, fade, deadline, now)) break;
      this.deletePending(id);
      this.onReadinessChanged?.(id, this.#finishes.get(id)?.finish ?? 0);
    }
    return visited;
  }
  private deletePending(id: string): void {
    this.#pending.delete(id);
    this.#visibleMemberships.delete(id);
  }
  private queueMembership(id: string, fade: PendingFade, visible: boolean): void {
    this.#pending.set(id, fade);
    if (visible) this.#visibleMemberships.set(id, fade);
  }
  private writeFade(
    entry: MountedSceneElement,
    fade: PendingFade,
    deadline: number,
    now: () => number,
  ): boolean {
    if (fade.index === 0) {
      const presentation = elementFadePresentation(entry);
      if (entry.fadeActive && entry.fadePresentation !== presentation) {
        setMountedElementFade(entry, null);
        this.releaseStyledGenerations(entry.id);
      }
      entry.fadePresentation = presentation;
    }
    entry.fadeActive = true;
    const presentation = entry.fadePresentation!;
    const count = elementFadeTargetCount(entry, presentation);
    const duration = this.fadeDuration(entry, fade);
    do {
      const node = elementFadeTarget(entry, fade.index, presentation);
      if (node !== undefined) {
        setElementFadeNode(node, duration, presentation, fade.direction, fade.generation);
        if (node.style.getPropertyValue("visibility")) node.style.removeProperty("visibility");
      }
      if (entry.group?.style.getPropertyValue("visibility"))
        entry.group.style.removeProperty("visibility");
      if (node !== undefined)
        this.writeStyledGeneration(
          entry.id,
          fade.index,
          duration > 0 ? fade.generation : undefined,
        );
      fade.index += 1;
      this.#remaining -= 1;
      const finish = now() + duration;
      if (fade.direction === "exit") {
        fade.finish = finish;
        this.#finishes.set(entry.id, fade);
      } else this.#entranceFinishes.set(entry.id, { finish, index: 0 });
    } while (fade.index < count && this.#remaining > 0 && now() < deadline);
    return fade.index >= count;
  }
  private fadeDuration(entry: MountedSceneElement, fade: PendingFade): number {
    fade.admittedDurationMs ??=
      fade.generation !== undefined && !this.membershipVisible(fade.bounds, entry)
        ? 0
        : fade.durationMs;
    const interrupted =
      this.#reducedMotion ||
      (fade.exitVersion !== undefined && fade.exitVersion <= this.#reducedThrough) ||
      this.interrupted(entry.id);
    return interrupted ? 0 : fade.admittedDurationMs;
  }
  private cleanupEntrances(deadline: number, now: () => number): void {
    for (const [id, finish] of this.#entranceFinishes) {
      if (
        (!this.interrupted(id) && now() < finish.finish) ||
        this.#remaining <= 0 ||
        (this.#remaining < FADE_NODES_PER_FRAME && now() >= deadline)
      )
        break;
      if (this.#pending.has(id)) continue;
      const entry = this.mounted.get(id);
      if (entry === undefined) {
        this.#entranceFinishes.delete(id);
        this.releaseMembership(id);
        this.releaseStyledGenerations(id);
        this.#remaining -= 1;
        continue;
      }
      const presentation = entry.fadePresentation!;
      const count = elementFadeTargetCount(entry, presentation);
      do {
        const node = elementFadeTarget(entry, finish.index, presentation);
        if (node !== undefined) {
          setElementFadeNode(node, null, presentation);
          this.writeStyledGeneration(id, finish.index, undefined);
        }
        finish.index += 1;
        this.#remaining -= 1;
      } while (finish.index < count && this.#remaining > 0 && now() < deadline);
      if (finish.index < count) break;
      entry.fadeActive = false;
      entry.fadePresentation = null;
      this.#entranceFinishes.delete(id);
      this.releaseMembership(id);
      this.releaseStyledGenerations(id);
    }
  }
  private pruneEntrances(deadline: number, now: () => number): void {
    const prune = this.#prune;
    if (prune === undefined) return;
    let visited = false;
    while ((!visited && this.#remaining === FADE_NODES_PER_FRAME) || now() < deadline) {
      const next = prune.ids.next();
      if (next.done) {
        this.#prune = undefined;
        return;
      }
      if (!prune.contains(next.value[0])) {
        this.#entrances.delete(next.value[0]);
        this.releaseMembership(next.value[0]);
      }
      visited = true;
    }
  }
  private interrupted(id: string): boolean {
    const membership = this.#memberships.get(id);
    return membership !== undefined && membership.generation <= this.#interruptedThrough;
  }
  private membershipVisible(
    bounds: Bounds | undefined,
    entry: MountedSceneElement | undefined,
  ): boolean {
    return (
      bounds === undefined ||
      this.#viewport === undefined ||
      entry?.motionActive === true ||
      entry?.appliedPreviewTransform != null ||
      (entry !== undefined && entry.displayedPathParts !== entry.pathParts) ||
      intersects(bounds, this.#viewport)
    );
  }
  private releaseMembership(id: string): void {
    const membership = this.#memberships.get(id);
    if (membership === undefined) return;
    this.#memberships.delete(id);
    this.releaseGeneration(membership.generation);
  }
  private writeStyledGeneration(id: string, index: number, generation: number | undefined): void {
    let styles = this.#styledGenerations.get(id);
    const previous = styles?.targets[index];
    if (previous === generation) return;
    if (previous !== undefined) {
      styles!.count -= 1;
      this.#styledGenerationCount -= 1;
      this.releaseGeneration(previous);
    }
    if (generation !== undefined) {
      if (styles === undefined) {
        styles = { targets: [], count: 0 };
        this.#styledGenerations.set(id, styles);
      }
      styles.count += 1;
      this.#styledGenerationCount += 1;
      this.#generations.set(generation, (this.#generations.get(generation) ?? 0) + 1);
    }
    if (styles !== undefined) styles.targets[index] = generation;
    if (styles?.count === 0) this.#styledGenerations.delete(id);
  }
  private releaseStyledGenerations(id: string): void {
    const styles = this.#styledGenerations.get(id);
    if (styles === undefined) return;
    this.#styledGenerations.delete(id);
    this.#styledGenerationCount -= styles.count;
    for (const generation of styles.targets)
      if (generation !== undefined) this.releaseGeneration(generation);
  }
  private releaseGeneration(generation: number): void {
    const remaining = (this.#generations.get(generation) ?? 1) - 1;
    if (remaining > 0) this.#generations.set(generation, remaining);
    else {
      this.#generations.delete(generation);
      this.membershipGate?.(generation, false);
    }
  }
}
