export class InitialSceneReadiness {
  #layoutReady = false;
  #completed = false;

  /** Requests one fresh scene commit after the final initial layout is known. */
  public markLayoutReady(): boolean {
    if (this.#layoutReady) return false;
    this.#layoutReady = true;
    return true;
  }

  public markSceneCommitted(): boolean {
    if (this.#completed || !this.#layoutReady) return false;
    this.#completed = true;
    return true;
  }
}
