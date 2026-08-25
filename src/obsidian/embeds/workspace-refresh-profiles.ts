import type { RefreshRatePreferenceV2 } from "../../domain/settings";
import { WindowRefreshRateProfiles } from "../performance";

const CONSERVATIVE_SLICE_BUDGET_MS = (1_000 / 240) * 0.55;

export class WorkspaceRefreshProfiles {
  readonly #profiles: WindowRefreshRateProfiles;
  readonly #releases = new Map<string, () => void>();

  public constructor(preference: RefreshRatePreferenceV2) {
    this.#profiles = new WindowRefreshRateProfiles(preference);
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
      ? CONSERVATIVE_SLICE_BUDGET_MS
      : this.#profiles.profile(ownerWindow).sliceBudgetMs;
  }

  public setPreference(preference: RefreshRatePreferenceV2): void {
    this.#profiles.setPreference(preference);
  }

  public dispose(): void {
    for (const release of this.#releases.values()) release();
    this.#releases.clear();
    this.#profiles.dispose();
  }
}
