import type { RefreshRatePreferenceV2 } from "../../domain/settings";
import {
  DEFAULT_REFRESH_RATE,
  type RefreshRateProfileStatus,
  WindowRefreshRateProfiles,
} from "../performance";

const DEFAULT_SLICE_BUDGET_MS = (1_000 / DEFAULT_REFRESH_RATE) * 0.55;

export class WorkspaceRefreshProfiles {
  #defaultRelease: (() => void) | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #profiles: WindowRefreshRateProfiles;
  readonly #releases = new Map<string, () => void>();

  public constructor(preference: RefreshRatePreferenceV2) {
    this.#profiles = new WindowRefreshRateProfiles(preference, () => this.#notify());
  }

  public observeDefault(ownerWindow: Window | undefined): void {
    this.#defaultRelease?.();
    this.#defaultRelease =
      ownerWindow === undefined
        ? undefined
        : this.#profiles.acquire(ownerWindow, ownerWindow.document);
  }

  public acquire(key: string, ownerWindow: Window | null, ownerDocument: Document): void {
    if (ownerWindow !== null) {
      this.#releases.set(key, this.#profiles.acquire(ownerWindow, ownerDocument));
    }
  }

  public release(key: string): void {
    this.#releases.get(key)?.();
    this.#releases.delete(key);
  }

  public sliceBudgetMs(ownerWindow: Window | null): number {
    return ownerWindow === null
      ? DEFAULT_SLICE_BUDGET_MS
      : this.#profiles.profile(ownerWindow).sliceBudgetMs;
  }

  public status(ownerWindow: Window | null): RefreshRateProfileStatus {
    return this.#profiles.status(ownerWindow ?? undefined);
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public setPreference(preference: RefreshRatePreferenceV2): void {
    this.#profiles.setPreference(preference);
  }

  public dispose(): void {
    this.#defaultRelease?.();
    this.#defaultRelease = undefined;
    for (const release of this.#releases.values()) release();
    this.#releases.clear();
    this.#profiles.dispose();
    this.#listeners.clear();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
