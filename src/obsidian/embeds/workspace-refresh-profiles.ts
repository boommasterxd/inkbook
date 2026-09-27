import type { RefreshRatePreferenceV2 } from "../../domain/settings";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { createWindowWorkScheduler } from "../performance/window-work-scheduler";
import { type RefreshRateProfileStatus, WindowRefreshRateProfiles } from "../performance";

export class WorkspaceRefreshProfiles {
  #defaultRelease: (() => void) | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #profiles: WindowRefreshRateProfiles;
  readonly #releases = new Map<string, () => void>();
  readonly #schedulers = new Map<
    Window,
    { scheduler: WorkScheduler; release: () => void; refreshProfile: () => void }
  >();
  #defaultWindow: Window | undefined;
  #disposed = false;

  public constructor(preference: RefreshRatePreferenceV2) {
    this.#profiles = new WindowRefreshRateProfiles(preference, () => this.#notify());
  }

  public observeDefault(ownerWindow: Window | undefined): void {
    this.#defaultWindow = ownerWindow;
    this.#defaultRelease?.();
    this.#defaultRelease =
      ownerWindow === undefined
        ? undefined
        : this.#profiles.acquire(ownerWindow, ownerWindow.document);
  }

  public acquire(key: string, ownerWindow: Window | null, ownerDocument: Document): void {
    if (ownerWindow !== null) {
      this.#releases.get(key)?.();
      this.#releases.set(key, this.#profiles.acquire(ownerWindow, ownerDocument));
    }
  }

  public release(key: string): void {
    this.#releases.get(key)?.();
    this.#releases.delete(key);
  }

  public workScheduler(ownerWindow: Window | null): WorkScheduler {
    if (this.#disposed) throw new Error("Workspace scheduling is disposed.");
    const target = ownerWindow ?? this.#defaultWindow;
    if (target === undefined) throw new Error("Frame work requires an owning window.");
    const existing = this.#schedulers.get(target);
    if (existing !== undefined) return existing.scheduler;
    let profile = this.#profiles.profile(target);
    const scheduler = createWindowWorkScheduler(target, () => profile);
    const onUnload = () => {
      scheduler.dispose();
      this.#schedulers.delete(target);
    };
    target.addEventListener("unload", onUnload, { once: true });
    this.#schedulers.set(target, {
      scheduler,
      refreshProfile: () => {
        profile = this.#profiles.profile(target);
      },
      release: () => {
        target.removeEventListener("unload", onUnload);
        scheduler.dispose();
      },
    });
    return scheduler;
  }

  public status(ownerWindow: Window | null): RefreshRateProfileStatus {
    return this.#profiles.status(ownerWindow ?? undefined);
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public notifyOwnerWindowChanged(): void {
    this.#notify();
  }

  public setPreference(preference: RefreshRatePreferenceV2): void {
    this.#profiles.setPreference(preference);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const entry of this.#schedulers.values()) entry.release();
    this.#schedulers.clear();
    this.#defaultWindow = undefined;
    this.#defaultRelease?.();
    this.#defaultRelease = undefined;
    for (const release of this.#releases.values()) release();
    this.#releases.clear();
    this.#profiles.dispose();
    this.#listeners.clear();
  }

  #notify(): void {
    for (const entry of this.#schedulers.values()) entry.refreshProfile();
    for (const listener of this.#listeners) listener();
  }
}
