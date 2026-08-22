export class InitialSceneReadiness {
  #layoutReady = false;
  #sceneCommitted = false;
  #completed = false;

  public markLayoutReady(): boolean {
    this.#layoutReady = true;
    return this.#completeWhenReady();
  }

  public markSceneCommitted(): boolean {
    this.#sceneCommitted = true;
    return this.#completeWhenReady();
  }

  #completeWhenReady(): boolean {
    if (this.#completed || !this.#layoutReady || !this.#sceneCommitted) return false;
    this.#completed = true;
    return true;
  }
}
