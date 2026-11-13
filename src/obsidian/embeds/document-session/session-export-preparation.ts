import type { AutosaveCoordinator } from "../../../persistence/saving/autosave/public";

/** One active presentation owns pending source until preparation or explicit discard. */
export class SessionExportPreparation {
  #prepare: (() => Promise<void>) | undefined;
  #generation = 0;
  #running: Promise<void> | undefined;
  #release: (() => void) | undefined;

  get pending(): boolean {
    return this.#prepare !== undefined || this.#running !== undefined;
  }

  register(prepare: () => Promise<void>): () => void {
    if (this.#prepare !== undefined) throw new Error("Document preparation already owned.");
    this.#prepare = prepare;
    return () => {
      if (this.#prepare === prepare) this.#prepare = undefined;
    };
  }

  actions(active: () => boolean): {
    preparePendingInput(): Promise<void>;
    registerExportPreparation(prepare: () => Promise<void>): () => void;
  } {
    this.clear();
    return {
      preparePendingInput: async () => {
        if (!active()) throw new Error("The document session is unavailable.");
        await this.prepare();
      },
      registerExportPreparation: (prepare) => {
        if (!active()) throw new Error("The document session is unavailable.");
        return this.register(prepare);
      },
    };
  }

  clear(): void {
    this.#generation += 1;
    this.#running = undefined;
    this.#prepare = undefined;
    this.#releaseOwnedPresentation();
  }

  prepare(): Promise<void> {
    if (this.#running !== undefined) return this.#running;
    const prepare = this.#prepare;
    if (prepare === undefined) {
      this.#releaseOwnedPresentation();
      return Promise.resolve();
    }
    const generation = this.#generation;
    const running = (async () => {
      await prepare();
      if (generation === this.#generation) this.#releaseOwnedPresentation();
    })();
    this.#running = running;
    void running.then(
      () => this.#settled(running),
      () => this.#settled(running),
    );
    return running;
  }

  deferRelease(release: () => void, failed: () => void): void {
    if (!this.pending) {
      release();
      return;
    }
    this.#release ??= release;
    void this.prepare().catch(failed);
  }

  externalChange(
    autosave: AutosaveCoordinator,
  ): ReturnType<AutosaveCoordinator["notifyExternalChange"]> {
    return this.pending ? Promise.resolve("conflict") : autosave.notifyExternalChange();
  }

  async flush(
    currentAutosave: () => AutosaveCoordinator | undefined,
    lifecycle: { readonly disposed: boolean },
  ): Promise<void> {
    await this.prepare();
    if (lifecycle.disposed) throw new Error("The document session is unavailable.");
    const autosave = currentAutosave();
    if (autosave === undefined) return;
    await autosave.currentSaveSettlement;
    if (autosave.status === "verification-required") await autosave.retryVerification();
    if ((await autosave.flush("export")) !== "clean" || lifecycle.disposed) {
      throw new Error("Could not persist the latest Inkbook document for export.");
    }
  }

  async unload(autosave: AutosaveCoordinator | undefined, dispose: () => void): Promise<void> {
    await autosave?.currentSaveSettlement;
    if (autosave?.status === "verification-required") await autosave.retryVerification();
    if (autosave !== undefined && autosave.dirty && (await autosave.flush("detach")) !== "clean") {
      throw new Error("Could not persist the latest Inkbook document before unloading.");
    }
    dispose();
  }

  #settled(running: Promise<void>): void {
    if (this.#running === running) this.#running = undefined;
  }

  #releaseOwnedPresentation(): void {
    const release = this.#release;
    this.#release = undefined;
    release?.();
  }
}
