import type { RefreshRatePreferenceV2 } from "../../domain/settings";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { createWindowWorkScheduler } from "../performance/window-work-scheduler";
import { type RefreshRateProfileStatus, WindowRefreshRateProfiles } from "../performance";

export class WorkspaceRefreshProfiles {
  #defaultRelease: (() => void) | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #profiles: WindowRefreshRateProfiles;
  readonly #releases = new Map<string, { ownerWindow: Window; release: () => void }>();
  readonly #schedulers = new Map<
    Window,
    { scheduler: WorkScheduler; release: () => void; refreshProfile: () => void }
  >();
  #defaultWindow: Window | undefined;
  #disposed = false;
  #ownerWindowVersion = 0;
  readonly #unloadedWindows = new WeakSet<Window>();

  public constructor(preference: RefreshRatePreferenceV2) {
    this.#profiles = new WindowRefreshRateProfiles(preference, () => this.#notify());
  }

  public observeDefault(ownerWindow: Window | undefined): void {
    if (this.#defaultWindow === ownerWindow) return;
    this.#defaultWindow = ownerWindow;
    this.#defaultRelease?.();
    this.#defaultRelease =
      ownerWindow === undefined
        ? undefined
        : this.#profiles.acquire(ownerWindow, ownerWindow.document);
    this.notifyOwnerWindowChanged();
  }

  public acquire(key: string, ownerWindow: Window | null, ownerDocument: Document): void {
    if (this.#releases.get(key)?.ownerWindow === ownerWindow) return;
    this.release(key);
    if (ownerWindow !== null) {
      this.#releases.set(key, {
        ownerWindow,
        release: this.#profiles.acquire(ownerWindow, ownerDocument),
      });
    }
    this.notifyOwnerWindowChanged();
  }

  public release(key: string): void {
    this.#releases.get(key)?.release();
    this.#releases.delete(key);
  }

  public workScheduler(ownerWindow: Window | null): WorkScheduler {
    if (this.#disposed) throw new Error("Workspace scheduling is disposed.");
    const target = ownerWindow ?? this.#defaultWindow;
    if (target === undefined) throw new Error("Frame work requires an owning window.");
    if (!this.isWindowAvailable(target)) throw new Error("Frame owner window unloaded.");
    const existing = this.#schedulers.get(target);
    if (existing !== undefined) return existing.scheduler;
    let profile = this.#profiles.profile(target);
    const scheduler = createWindowWorkScheduler(target, () => profile);
    const onUnload = () => {
      this.#unloadedWindows.add(target);
      scheduler.dispose();
      this.#schedulers.delete(target);
      this.notifyOwnerWindowChanged();
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
    this.#ownerWindowVersion += 1;
    this.#notify();
  }

  public ownerWindowVersion(): number {
    return this.#ownerWindowVersion;
  }

  public isWindowAvailable(ownerWindow: Window): boolean {
    return !this.#unloadedWindows.has(ownerWindow);
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
    for (const entry of this.#releases.values()) entry.release();
    this.#releases.clear();
    this.#profiles.dispose();
    this.#listeners.clear();
  }

  #notify(): void {
    for (const entry of this.#schedulers.values()) entry.refreshProfile();
    for (const listener of this.#listeners) listener();
  }
}
