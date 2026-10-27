import { firstPath, type MountedSceneElement } from "../content/mounted-element";
import type { SceneDeltaEntry } from "../types";

interface PreparedRoots {
  readonly root: SVGElement;
  readonly count: number;
  readonly band: MountedSceneElement["band"];
  readonly rank: number;
}

/** Retains a ready physical cohort while existing geometry publications catch up.
 * It owns changed-member proofs only, never a second Store ordering index. */
export class SelectionRunRebase {
  #roots = new Map<string, PreparedRoots>();
  #active = false;
  public get active(): boolean {
    return this.#active;
  }
  public get pending(): boolean {
    return this.#roots.size > 0;
  }

  public track(
    change: SceneDeltaEntry | undefined,
    entry: MountedSceneElement | undefined,
    mounted: MountedSceneElement | undefined,
  ): boolean {
    if (
      change?.before == null ||
      change.after == null ||
      change.before.kind !== change.after.kind ||
      !change.domains.every((domain) => domain === "geometry" || domain === "connection")
    )
      return false;
    if (entry !== undefined) {
      if (entry !== mounted || change.afterPaintVersion !== entry.paintVersion) return false;
      if (!this.#roots.has(entry.id))
        this.#roots.set(entry.id, {
          root: firstPath(entry),
          count: entry.paths.length,
          band: entry.band,
          rank: entry.rank,
        });
    }
    this.#active = true;
    return true;
  }

  public published(entry: MountedSceneElement): "untracked" | "valid" | "invalid" {
    const previous = this.#roots.get(entry.id);
    if (previous === undefined) return "untracked";
    this.#roots.delete(entry.id);
    return firstPath(entry) === previous.root &&
      entry.paths.length === previous.count &&
      entry.band === previous.band &&
      entry.rank === previous.rank
      ? "valid"
      : "invalid";
  }

  public clear(): void {
    this.#active = false;
    this.#roots = new Map();
  }
  public memoryUsage(): number {
    return 64 + this.#roots.size * 80;
  }
}
